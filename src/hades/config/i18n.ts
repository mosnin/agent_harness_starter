export type Messages = Record<string, string>;

/** English (default) message catalog. */
export const en: Messages = {
  "cli.help.title": "hades — the learning agent on top of the swarm",
  "repl.welcome": "Welcome to Hades. Type /help for commands.",
  "repl.goodbye": "Goodbye.",
  "memory.remembered": "Remembered: {fact}",
  "memory.none": "No matching memories.",
  "model.switched": "Switched to {model}.",
  "gateway.unauthorized": "You are not authorized to use the swarm here.",
};

/** Spanish catalog (partial — falls back to English for missing keys). */
export const es: Messages = {
  "repl.welcome": "Bienvenido a Hades. Escribe /help para ver los comandos.",
  "repl.goodbye": "Adiós.",
  "memory.remembered": "Recordado: {fact}",
  "memory.none": "No hay recuerdos coincidentes.",
  "model.switched": "Cambiado a {model}.",
  "gateway.unauthorized": "No tienes autorización para usar el enjambre aquí.",
};

export const CATALOGS: Record<string, Messages> = { en, es };

/**
 * Minimal i18n translator. `t(key, params)` looks up the active locale, falls
 * back to the default locale (then the key itself), and interpolates `{name}`
 * placeholders. Deliberately dependency-free — the scaffolding domain packs and
 * front-ends localize against, not a full ICU implementation.
 */
export class I18n {
  private locale: string;

  constructor(
    private readonly catalogs: Record<string, Messages> = CATALOGS,
    locale = "en",
    private readonly fallback = "en"
  ) {
    this.locale = locale;
  }

  setLocale(locale: string): void {
    this.locale = locale;
  }
  currentLocale(): string {
    return this.locale;
  }
  availableLocales(): string[] {
    return Object.keys(this.catalogs);
  }

  has(key: string): boolean {
    return key in (this.catalogs[this.locale] ?? {}) || key in (this.catalogs[this.fallback] ?? {});
  }

  t(key: string, params: Record<string, string | number> = {}): string {
    const template =
      this.catalogs[this.locale]?.[key] ?? this.catalogs[this.fallback]?.[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, name: string) =>
      name in params ? String(params[name]) : `{${name}}`
    );
  }
}

export function defaultI18n(locale = "en"): I18n {
  return new I18n(CATALOGS, locale);
}
