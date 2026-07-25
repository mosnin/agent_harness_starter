/**
 * Secret-safe key extraction: real dotenv/shell-profile parsing plus a
 * vault that structurally cannot leak the key material it holds.
 *
 * The vault (`SecretVault`) is the load-bearing invariant here: every path
 * that could ever expose a JS object to a human or a log line —
 * `JSON.stringify`, template-literal interpolation, `util.inspect`,
 * `console.log` — is wired to emit `SecretDescriptor`s (metadata: env var
 * name, provider guess, a truncated sha256 fingerprint, length) and never
 * the raw material. The material itself lives in a private class field that
 * is never exposed by any enumerable property, getter, `toJSON`, or
 * `[util.inspect.custom]`. The *only* way to get the real value back out is
 * `vault.take(envVar)`, called explicitly.
 */

import { inspect } from "node:util";
import { sha256Hex } from "../styx/certificate";
import type { JsonValue } from "../state/record";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export interface SecretDescriptor {
  envVar: string;
  provider: string;
  fingerprint: string;
  length: number;
  origin: { path: string; locator?: string };
  confidence: number;
  looksValid: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// SecretVault — leak-proof by construction
// ---------------------------------------------------------------------------

interface VaultEntry {
  descriptor: SecretDescriptor;
  material: string;
}

export class SecretVault {
  // Private class field: not enumerable, not visible to JSON.stringify,
  // util.inspect, Object.keys, spread, or structuredClone-style walks.
  readonly #entries: VaultEntry[] = [];

  /**
   * Registers a secret. `material` is the real value; it is never copied
   * into the returned descriptor. Returns the stored descriptor (frozen —
   * callers can inspect it but not mutate vault-internal state through it).
   */
  add(d: Omit<SecretDescriptor, "fingerprint" | "length">, material: string): SecretDescriptor {
    const descriptor: SecretDescriptor = Object.freeze({
      ...d,
      fingerprint: sha256Hex(material).slice(0, 12),
      length: material.length,
    });
    this.#entries.push({ descriptor, material });
    return descriptor;
  }

  /** All descriptors currently held, in insertion order. Never includes material. */
  list(): SecretDescriptor[] {
    return this.#entries.map((e) => e.descriptor);
  }

  has(envVar: string): boolean {
    return this.#entries.some((e) => e.descriptor.envVar === envVar);
  }

  /**
   * Returns the real material for `envVar` (most-recently-added entry wins
   * if there are duplicates), or `undefined` if not present. This is the
   * only method in this module that ever returns raw secret material.
   */
  take(envVar: string): string | undefined {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (this.#entries[i].descriptor.envVar === envVar) return this.#entries[i].material;
    }
    return undefined;
  }

  get size(): number {
    return this.#entries.length;
  }

  /** Called automatically by `JSON.stringify(vault)`. Descriptors only. */
  toJSON(): SecretDescriptor[] {
    return this.list();
  }

  /** Called automatically by template-literal interpolation and string coercion. Descriptors only. */
  toString(): string {
    const names = this.#entries.map((e) => e.descriptor.envVar).join(", ");
    return `SecretVault(${this.size} secret${this.size === 1 ? "" : "s"}${names ? `: ${names}` : ""})`;
  }

  /** Called automatically by `util.inspect(vault)` / `console.log(vault)`. Descriptors only. */
  [inspect.custom](): string {
    return `${this.toString()} ${inspect(this.list(), { depth: 4 })}`;
  }
}

// ---------------------------------------------------------------------------
// Dotenv / shell-profile parsing
//
// A single hand-rolled scanner implements real dotenv grammar: `export`
// prefix, single- and double-quoted values (with backslash escapes and
// multi-line support inside quotes), unquoted values with trailing-comment
// stripping, `#`-inside-quotes is literal, CRLF/BOM handling, and blank /
// comment lines. It never executes or interpolates shell — `$VAR`, `` `cmd` ``,
// etc. are kept as inert literal text.
// ---------------------------------------------------------------------------

interface RawAssignment {
  key: string;
  value: string;
  line: number;
  exported: boolean;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function scanAssignments(text: string): RawAssignment[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const results: RawAssignment[] = [];
  const len = text.length;
  let i = 0;
  let line = 1;

  while (i < len) {
    // Skip leading horizontal whitespace.
    while (i < len && (text[i] === " " || text[i] === "\t")) i++;
    if (i >= len) break;
    if (text[i] === "\n") {
      i++;
      line++;
      continue;
    }
    if (text[i] === "\r") {
      i++;
      continue;
    }
    if (text[i] === "#") {
      while (i < len && text[i] !== "\n") i++;
      continue;
    }

    let exported = false;
    if (text.startsWith("export", i)) {
      const after = text[i + 6];
      if (after === " " || after === "\t") {
        exported = true;
        i += 6;
        while (i < len && (text[i] === " " || text[i] === "\t")) i++;
      }
    }

    const keyMatch = KEY_RE.exec(text.slice(i));
    if (!keyMatch) {
      while (i < len && text[i] !== "\n") i++;
      continue;
    }
    const key = keyMatch[0];
    i += key.length;
    while (i < len && (text[i] === " " || text[i] === "\t")) i++;
    if (text[i] !== "=") {
      // Not an assignment line (e.g. a shell keyword, a function name); skip it.
      while (i < len && text[i] !== "\n") i++;
      continue;
    }
    i++; // consume '='
    while (i < len && (text[i] === " " || text[i] === "\t")) i++;

    const startLine = line;
    let value: string;

    if (text[i] === '"') {
      i++;
      let v = "";
      while (i < len) {
        const c = text[i];
        if (c === "\\") {
          const next = text[i + 1];
          if (next === "n") v += "\n";
          else if (next === "t") v += "\t";
          else if (next === "r") v += "\r";
          else if (next === "\\") v += "\\";
          else if (next === '"') v += '"';
          else if (next === "$") v += "$";
          else if (next === "`") v += "`";
          else if (next === "\n") {
            v += "\n";
            line++;
          } else v += "\\" + (next ?? "");
          i += 2;
          continue;
        }
        if (c === '"') {
          i++;
          break;
        }
        if (c === "\n") {
          v += "\n";
          i++;
          line++;
          continue;
        }
        v += c;
        i++;
      }
      value = v;
    } else if (text[i] === "'") {
      i++;
      let v = "";
      while (i < len) {
        const c = text[i];
        if (c === "'") {
          i++;
          break;
        }
        if (c === "\n") {
          v += "\n";
          i++;
          line++;
          continue;
        }
        v += c;
        i++;
      }
      value = v;
    } else {
      let raw = "";
      while (i < len && text[i] !== "\n") {
        raw += text[i];
        i++;
      }
      raw = raw.replace(/\r$/, "");
      let commentIdx = -1;
      for (let k = 0; k < raw.length; k++) {
        if (raw[k] === "#" && (k === 0 || /\s/.test(raw[k - 1]))) {
          commentIdx = k;
          break;
        }
      }
      if (commentIdx !== -1) raw = raw.slice(0, commentIdx);
      value = raw.trim();
    }

    // Discard any trailing same-line content after a closing quote.
    while (i < len && text[i] !== "\n") i++;

    results.push({ key, value, line: startLine, exported });
  }

  return results;
}

/** Real dotenv-file parsing. Never executes or interpolates shell. */
export function parseEnvFile(text: string): Array<{ key: string; value: string; line: number; exported: boolean }> {
  return scanAssignments(text);
}

/**
 * Scans a shell profile (`.bashrc`, `.zshrc`, `.profile`, ...) for
 * `[export] KEY=VALUE`-shaped assignments, using the same real grammar as
 * `parseEnvFile`. Everything else in the file (functions, conditionals,
 * aliases, command substitution) is inert text as far as this scanner is
 * concerned — it never executes anything.
 */
export function scanShellProfile(text: string): Array<{ key: string; value: string; line: number }> {
  return scanAssignments(text).map(({ key, value, line }) => ({ key, value, line }));
}

// ---------------------------------------------------------------------------
// Vendor-config secret harvesting
// ---------------------------------------------------------------------------

const SECRET_KEY_NAME_RE = /(apikey|api_key|token|secret|authorization|auth)/;
const GENERIC_WRAPPER_KEYS = new Set(["config", "settings", "secrets", "auth", "credentials", "env", "options"]);

function isSecretKeyName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return SECRET_KEY_NAME_RE.test(normalized) || normalized === "authorization" || normalized === "auth";
}

function toEnvVarName(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join("_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^_+|_+$/g, "");
}

/**
 * Recursively walks a parsed vendor-config JSON value, harvesting fields
 * shaped like `apiKey` / `api_key` / `token` / `secret` / `authorization`
 * whose value is a non-empty string.
 */
export function harvestConfigSecrets(
  value: JsonValue,
  origin: { path: string },
): Array<{ envVar: string; material: string; locator: string; provider: string }> {
  const results: Array<{ envVar: string; material: string; locator: string; provider: string }> = [];

  function walk(node: JsonValue, jsonPath: string, parentKey: string | undefined): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, `${jsonPath}[${idx}]`, parentKey));
      return;
    }
    for (const [key, val] of Object.entries(node)) {
      const childPath = `${jsonPath}.${key}`;
      if (typeof val === "string" && val.trim().length > 0 && isSecretKeyName(key)) {
        const useParent = parentKey && !GENERIC_WRAPPER_KEYS.has(parentKey.toLowerCase()) ? parentKey : undefined;
        const envVar = useParent ? toEnvVarName(useParent, key) : toEnvVarName(key);
        const provider = classifyProviderKey(envVar, val).provider;
        results.push({ envVar, material: val, locator: `${origin.path}#${childPath}`, provider });
      } else if (val !== null && typeof val === "object") {
        walk(val, childPath, key);
      }
    }
  }

  walk(value, "$", undefined);
  return results;
}

// ---------------------------------------------------------------------------
// Provider classification
// ---------------------------------------------------------------------------

const ENV_NAME_PROVIDERS: Array<[RegExp, string]> = [
  // Azure is checked before "openai"/"mistral": Azure-hosted keys are
  // conventionally named e.g. AZURE_OPENAI_API_KEY, which would otherwise
  // also match the generic "openai" pattern below.
  [/azure/i, "azure"],
  [/anthropic/i, "anthropic"],
  [/openrouter/i, "openrouter"],
  [/openai/i, "openai"],
  [/\b(google|gemini|palm|vertex)\b/i, "google"],
  [/mistral/i, "mistral"],
  [/groq/i, "groq"],
  [/together/i, "together"],
  [/deepseek/i, "deepseek"],
  [/\bxai\b|\bgrok\b/i, "xai"],
];

const MATERIAL_PREFIX_PROVIDERS: Array<[RegExp, string]> = [
  [/^sk-ant-/, "anthropic"],
  [/^sk-or-v1-/, "openrouter"],
  [/^sk-proj-/, "openai"],
  [/^gsk_/, "groq"],
  [/^xai-/, "xai"],
  [/^AIza[0-9A-Za-z_-]{10,}$/, "google"],
  // Generic "sk-<long token>" is a weak, last-resort OpenAI signal — many
  // vendors copied the shape, so it is checked after all specific prefixes.
  [/^sk-[A-Za-z0-9_-]{16,}$/, "openai"],
];

function detectProviderFromEnvVar(envVar: string): string | undefined {
  for (const [re, provider] of ENV_NAME_PROVIDERS) {
    if (re.test(envVar)) return provider;
  }
  return undefined;
}

function detectProviderFromMaterial(material: string): string | undefined {
  for (const [re, provider] of MATERIAL_PREFIX_PROVIDERS) {
    if (re.test(material)) return provider;
  }
  return undefined;
}

const PLACEHOLDER_LITERALS = new Set([
  "changeme",
  "change_me",
  "change-me",
  "yourkey",
  "your-key",
  "your_key",
  "yourapikey",
  "your-api-key",
  "your_api_key",
  "placeholder",
  "example",
  "dummy",
  "fake",
  "test",
  "testkey",
  "test-key",
  "test_key",
  "none",
  "null",
  "undefined",
  "insertkeyhere",
  "insert-key-here",
  "insert_key_here",
  "todo",
  "fixme",
  "replaceme",
  "replace-me",
  "replace_me",
  "redacted",
  "xxxxxxxx",
]);

function isPlaceholderValue(material: string): boolean {
  const m = material.trim();
  if (m.length === 0) return true;
  if (/^[<{].*[>}]$/.test(m)) return true; // <your-key>, {{API_KEY}}
  if (/\.\.\.$/.test(m)) return true; // "sk-..."
  const collapsed = m.toLowerCase().replace(/\s+/g, "");
  if (PLACEHOLDER_LITERALS.has(collapsed)) return true;
  const withoutSeparators = collapsed.replace(/[-_]/g, "");
  if (/^x+$/.test(withoutSeparators) && withoutSeparators.length > 0) return true;
  if (/^0+$/.test(withoutSeparators) && withoutSeparators.length > 0) return true;
  return false;
}

/**
 * Classifies which provider a `(envVar, material)` pair belongs to and
 * whether the value looks like a real, usable key rather than an obvious
 * placeholder. Never guesses a provider it cannot justify — falls back to
 * `"unknown"` rather than picking one arbitrarily.
 */
export function classifyProviderKey(
  envVar: string,
  material: string,
): { provider: string; looksValid: boolean; reason: string } {
  const byName = detectProviderFromEnvVar(envVar);
  const byMaterial = detectProviderFromMaterial(material);
  const provider = byName ?? byMaterial ?? "unknown";

  if (isPlaceholderValue(material)) {
    return { provider, looksValid: false, reason: "value looks like a placeholder/template, not real key material" };
  }
  if (byName) {
    return { provider, looksValid: true, reason: `env var name matches the known ${byName} naming convention` };
  }
  if (byMaterial) {
    return { provider, looksValid: true, reason: `key material prefix matches the known ${byMaterial} key format` };
  }
  if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(envVar) || /API_KEY/i.test(envVar)) {
    return {
      provider: "unknown",
      looksValid: looksLikeKeyMaterial(material),
      reason: "env var follows a generic *_API_KEY/_TOKEN convention but does not match a known provider",
    };
  }
  return {
    provider: "unknown",
    looksValid: looksLikeKeyMaterial(material),
    reason: "no known provider name or key-format signature matched",
  };
}

// ---------------------------------------------------------------------------
// Generic key-material heuristic (T1's validateBundle calls this)
// ---------------------------------------------------------------------------

/**
 * A general, provider-agnostic heuristic for "does this string look like it
 * could be secret key material at all" — long enough, drawn from a typical
 * token charset, and with enough character diversity to not be a repeated
 * placeholder like `xxxxxxxxxxxxxxxx`. Deliberately independent from
 * placeholder-literal detection (`classifyProviderKey` owns that).
 */
export function looksLikeKeyMaterial(v: string): boolean {
  const s = v.trim();
  if (s.length < 16) return false;
  if (!/^[A-Za-z0-9_\-./+=:]+$/.test(s)) return false;
  const hasDigit = /[0-9]/.test(s);
  const hasAlpha = /[A-Za-z]/.test(s);
  if (!hasDigit && !hasAlpha) return false;
  const distinctChars = new Set(s).size;
  if (distinctChars < 8) return false;
  return true;
}

/** Redacts a secret value for safe display: first 4 / last 4 chars, rest masked. */
export function redactValue(v: string): string {
  if (v.length === 0) return "";
  if (v.length <= 8) return "*".repeat(v.length);
  const head = v.slice(0, 4);
  const tail = v.slice(-4);
  return `${head}${"*".repeat(v.length - 8)}${tail}`;
}
