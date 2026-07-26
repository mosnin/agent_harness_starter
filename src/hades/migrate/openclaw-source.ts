/**
 * OpenClaw source reader: turns a {@link DiscoveredSource} (found by
 * `./discovery.ts`) into a canonical {@link MigrationBundle} plus a
 * {@link SecretVault}, mirroring `./hermes-source.ts`'s contract exactly
 * (same `SourceReadDeps`, same `readXSource(source, deps)` signature).
 *
 * Deliberately reuses the vendor-agnostic building blocks already proven out
 * in `hermes-source.ts` -- tree walking, glob matching, timestamp
 * disambiguation, dotenv parsing, MEMORY.md-style Facts extraction, SKILL.md
 * parsing/sanitization, JSONL session parsing, and secret-material detection
 * -- rather than re-implementing them, so the two vendors' bundles are
 * genuinely produced by the same tested logic wherever the shapes coincide.
 * What is unique to OpenClaw lives here: tolerant-JSONC config parsing,
 * `agents/*.json` profiles, and the legacy `~/.clawdbot` / `~/.moltbot`
 * root support (including the declared key-rename map).
 */

import type { DiscoveredSource } from "./discovery";
import { makeItem } from "./ir";
import type { MigrationBundle, MigrationItem } from "./ir";
import type { JsonValue } from "../state/record";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_ITEMS,
  SECRET_KEY_NAME_RE,
  findStringField,
  looksLikeKeyMaterial,
  parseTimestampFlexible,
  readDotenvFile,
  readMarkdownContextFile,
  readMemoryJsonArray,
  readSessionJsonl,
  readSkillFile,
  redactPreview,
  ruleMatches,
  safeReadFile,
  sanitizeEnvVarName,
  sanitizeSessionId,
  walkSourceTree,
} from "./hermes-source";
import type {
  ArtifactRule,
  ParsedSessionMessage,
  ReadErrorEntry,
  SecretVault,
  SecretVaultEntry,
  SourceReadDeps,
  UnimportableEntry,
} from "./hermes-source";

// Re-export the locked, vendor-agnostic contract types under this module too,
// so `import { SourceReadDeps, SecretVault, ArtifactRule } from "./openclaw-source"`
// works exactly like the `./hermes-source` equivalent (both resolve to the
// identical structural shape).
export type { ArtifactRule, SecretDescriptor, SecretVault, SecretVaultEntry, SourceReadDeps } from "./hermes-source";

// ---------------------------------------------------------------------------
// Declarative artifact table
// ---------------------------------------------------------------------------

export const OPENCLAW_ARTIFACTS: readonly ArtifactRule[] = Object.freeze([
  {
    relPathGlob: "openclaw.json",
    kind: "config",
    parser: "openclaw.config.jsonc",
    provenance:
      "openclaw.json is OpenClaw's primary configuration file. Tolerant JSONC: // and block comments plus trailing commas are stripped before parsing.",
  },
  {
    relPathGlob: "clawdbot.json",
    kind: "config",
    parser: "openclaw.config.legacy.clawdbot",
    provenance:
      "clawdbot.json is the legacy pre-rename configuration file, using clawdbot-era field names mapped via OPENCLAW_LEGACY_KEY_RENAME_MAP.",
  },
  {
    relPathGlob: "moltbot.json",
    kind: "config",
    parser: "openclaw.config.legacy.moltbot",
    provenance:
      "moltbot.json is the interim-rename configuration file, using moltbot-era field names mapped via OPENCLAW_LEGACY_KEY_RENAME_MAP.",
  },
  {
    relPathGlob: ".env",
    kind: "secret",
    parser: "dotenv",
    provenance: "OpenClaw reads provider API keys and other secrets from a dotenv file in its home directory.",
  },
  {
    relPathGlob: "agents/*.json",
    kind: "tool-state",
    parser: "openclaw.agent.json",
    provenance:
      "each agents/<name>.json profile records a named agent's model and behavior; the active/default agent's model contributes the model:selection item.",
  },
  {
    relPathGlob: "skills/*/SKILL.md",
    kind: "skill",
    parser: "skill-md",
    provenance: "skills/<name>/SKILL.md is OpenClaw's (and Hades') portable per-directory skill format.",
  },
  {
    relPathGlob: "plugins/*/SKILL.md",
    kind: "skill",
    parser: "skill-md",
    provenance: "legacy clawdbot skill-equivalents lived under plugins/ before the skills/ rename.",
  },
  {
    relPathGlob: "addons/*/SKILL.md",
    kind: "skill",
    parser: "skill-md",
    provenance: "legacy moltbot skill-equivalents lived under addons/ before the skills/ rename.",
  },
  {
    relPathGlob: "memory/*.md",
    kind: "context-file",
    parser: "openclaw.memory.md",
    provenance:
      "memory/<name>.md files hold durable context; a `## Facts` section, if present, is additionally parsed into structured memory items (same convention as Hermes' MEMORY.md).",
  },
  {
    relPathGlob: "sessions/*.json",
    kind: "session",
    parser: "openclaw.session.json",
    provenance: "sessions/<id>.json holds one saved OpenClaw session transcript as a single JSON document.",
  },
  {
    relPathGlob: "sessions/*.jsonl",
    kind: "session",
    parser: "openclaw.session.jsonl",
    provenance: "sessions/<id>.jsonl holds one saved OpenClaw session transcript, one message per line.",
  },
  {
    relPathGlob: "history/*.json",
    kind: "session",
    parser: "openclaw.session.json",
    provenance: "legacy clawdbot sessions lived under history/ before the sessions/ rename.",
  },
  {
    relPathGlob: "history/*.jsonl",
    kind: "session",
    parser: "openclaw.session.jsonl",
    provenance: "legacy clawdbot sessions lived under history/ before the sessions/ rename.",
  },
  {
    relPathGlob: "logs/*.json",
    kind: "session",
    parser: "openclaw.session.json",
    provenance: "legacy moltbot session logs lived under logs/ before the sessions/ rename.",
  },
  {
    relPathGlob: "logs/*.jsonl",
    kind: "session",
    parser: "openclaw.session.jsonl",
    provenance: "legacy moltbot session logs lived under logs/ before the sessions/ rename.",
  },
  {
    relPathGlob: "memory.json",
    kind: "memory",
    parser: "openclaw.memory.json",
    provenance: "legacy clawdbot flat memory.json before the memory/ directory convention.",
  },
  {
    relPathGlob: "state.json",
    kind: "tool-state",
    parser: "openclaw.state.json",
    provenance: "legacy moltbot flat runtime/tool-state file.",
  },
]);

/**
 * Legacy (clawdbot/moltbot) config field name -> current Hades dotted path,
 * declared as data (never hardcoded into branch logic) so the rename history
 * is inspectable and testable on its own.
 */
export const OPENCLAW_LEGACY_KEY_RENAME_MAP: Readonly<Record<string, AllowedConfigPath>> = Object.freeze({
  defaultModel: "model",
  botModel: "model",
  language: "locale",
  lang: "locale",
  triggerWord: "gateway.trigger",
  wakeWord: "gateway.trigger",
  authorizedUsers: "gateway.allowedUsers",
  allowedUsers: "gateway.allowedUsers",
  extensions: "plugins",
  addons: "plugins",
});

// ---------------------------------------------------------------------------
// Tolerant JSONC (comments + trailing commas), string-aware so nothing
// inside an actual JSON string value is ever misread as a comment or a
// trailing comma.
// ---------------------------------------------------------------------------

export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += input[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++; // consumed the '*'; the loop's i++ consumes the trailing '/'
      continue;
    }
    out += c;
  }
  return out;
}

export function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += input[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === "]" || input[j] === "}") continue; // drop this trailing comma
    }
    out += c;
  }
  return out;
}

/** Parses tolerant JSONC: `//` and block comments, plus trailing commas before `]`/`}`. Throws the underlying `JSON.parse` error on genuinely malformed input. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

// ---------------------------------------------------------------------------
// -0 sanitization for JSON.parse output passed through as-is into item values
// ---------------------------------------------------------------------------

function sanitizeJsonValue(v: unknown, depth = 0): JsonValue {
  if (depth > 32) return null;
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Object.is(v, -0) ? 0 : v;
  }
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => sanitizeJsonValue(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = sanitizeJsonValue(val, depth + 1);
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// config (openclaw.json current names, clawdbot/moltbot legacy names)
// ---------------------------------------------------------------------------

type AllowedConfigPath = "model" | "locale" | "plugins" | "gateway.trigger" | "gateway.allowedUsers";

interface ConfigExtraction {
  items: MigrationItem[];
  vaultEntries: SecretVaultEntry[];
  modelCandidate?: { value: string; originPath: string };
}

function scanForSecretishFields(
  obj: Record<string, unknown>,
  keyPrefix: string,
  originPath: string,
  mark: (key: string) => void,
  vaultEntries: SecretVaultEntry[],
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (SECRET_KEY_NAME_RE.test(key) || looksLikeKeyMaterial(value)) {
      mark(key);
      const envVar = sanitizeEnvVarName(`${keyPrefix}${key}`);
      vaultEntries.push({
        envVar,
        present: true,
        redactedPreview: redactPreview(value),
        value,
        origin: { path: originPath, locator: `${keyPrefix}${key}` },
      });
    }
  }
}

function extractOpenClawConfig(
  parsed: Record<string, unknown>,
  originPath: string,
  mode: "current" | "legacy",
  vendorFileLabel: string,
): ConfigExtraction {
  const items: MigrationItem[] = [];
  const vaultEntries: SecretVaultEntry[] = [];
  const secretishTop = new Set<string>();
  const secretishGateway = new Set<string>();

  scanForSecretishFields(parsed, "", originPath, (k) => secretishTop.add(k), vaultEntries);
  const gatewayObj =
    parsed.gateway && typeof parsed.gateway === "object" && !Array.isArray(parsed.gateway)
      ? (parsed.gateway as Record<string, unknown>)
      : undefined;
  if (gatewayObj) scanForSecretishFields(gatewayObj, "gateway.", originPath, (k) => secretishGateway.add(k), vaultEntries);

  const pushConfig = (path: AllowedConfigPath, value: JsonValue, confidence: number, note?: string) => {
    items.push(
      makeItem({
        kind: "config",
        key: `config:${path}`,
        value,
        origin: { path: originPath, locator: path },
        confidence,
        notes: note ? [note] : undefined,
      }),
    );
  };

  let modelCandidate: { value: string; originPath: string } | undefined;

  if (mode === "current") {
    if (!secretishTop.has("model") && typeof parsed.model === "string" && parsed.model.length > 0) {
      pushConfig("model", parsed.model, 1);
      modelCandidate = { value: parsed.model, originPath };
    }
    if (!secretishTop.has("locale") && typeof parsed.locale === "string" && parsed.locale.length > 0) {
      pushConfig("locale", parsed.locale, 1);
    }
    if (!secretishTop.has("plugins") && Array.isArray(parsed.plugins) && parsed.plugins.every((x) => typeof x === "string")) {
      pushConfig("plugins", parsed.plugins as JsonValue, 1);
    }
    if (gatewayObj) {
      if (!secretishGateway.has("trigger") && typeof gatewayObj.trigger === "string" && gatewayObj.trigger.length > 0) {
        pushConfig("gateway.trigger", gatewayObj.trigger, 1);
      }
      if (
        !secretishGateway.has("allowedUsers") &&
        Array.isArray(gatewayObj.allowedUsers) &&
        gatewayObj.allowedUsers.every((u) => typeof u === "string")
      ) {
        pushConfig("gateway.allowedUsers", gatewayObj.allowedUsers as JsonValue, 1);
      }
    }
  } else {
    for (const [legacyKey, path] of Object.entries(OPENCLAW_LEGACY_KEY_RENAME_MAP)) {
      if (secretishTop.has(legacyKey)) continue;
      if (!(legacyKey in parsed)) continue;
      const raw = parsed[legacyKey];
      const note = `heuristically mapped from ${vendorFileLabel} field "${legacyKey}" via OPENCLAW_LEGACY_KEY_RENAME_MAP`;
      if (path === "plugins" || path === "gateway.allowedUsers") {
        if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) pushConfig(path, raw as JsonValue, 0.6, note);
      } else if (typeof raw === "string" && raw.length > 0) {
        pushConfig(path, raw, 0.6, note);
        if (path === "model") modelCandidate = { value: raw, originPath };
      }
    }
  }

  return { items, vaultEntries, modelCandidate };
}

// ---------------------------------------------------------------------------
// agents/*.json
// ---------------------------------------------------------------------------

function fileStem(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.[^.]+$/, "");
}

function sanitizeToolStateSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.:-]/g, "_").replace(/^[^A-Za-z0-9]+/, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}

interface AgentExtraction {
  items: MigrationItem[];
  vaultEntries: SecretVaultEntry[];
  modelCandidate?: { value: string; originPath: string };
  unimportable?: UnimportableEntry;
}

function readAgentJson(text: string, relPath: string): AgentExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { items: [], vaultEntries: [], unimportable: { path: relPath, kind: "tool-state", reason: `agent file is not valid JSON: ${(e as Error).message}` } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { items: [], vaultEntries: [], unimportable: { path: relPath, kind: "tool-state", reason: "agent file top-level value is not a JSON object" } };
  }
  const o = parsed as Record<string, unknown>;
  const nameField = findStringField(o, ["name"]);
  const name = nameField?.value ?? fileStem(relPath);

  const vaultEntries: SecretVaultEntry[] = [];
  const cleaned: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" && (SECRET_KEY_NAME_RE.test(k) || looksLikeKeyMaterial(v))) {
      const envVar = sanitizeEnvVarName(`agent_${name}_${k}`);
      vaultEntries.push({ envVar, present: true, redactedPreview: redactPreview(v), value: v, origin: { path: relPath, locator: k } });
      continue;
    }
    cleaned[k] = sanitizeJsonValue(v);
  }

  const baseName = (relPath.split("/").pop() ?? "").toLowerCase();
  const isActive = o.active === true || o.default === true || baseName === "default.json" || baseName === "active.json";
  const modelField = findStringField(o, ["model", "modelId"]);
  const modelCandidate = isActive && modelField ? { value: modelField.value, originPath: relPath } : undefined;

  const item = makeItem({
    kind: "tool-state",
    key: `tool-state:agent:${sanitizeToolStateSegment(name)}`,
    value: cleaned,
    origin: { path: relPath },
    confidence: 0.8,
    notes: [`captured verbatim (minus any secret-looking fields, which were moved to the vault) from OpenClaw agent profile "${name}"`],
  });

  return { items: [item], vaultEntries, modelCandidate };
}

// ---------------------------------------------------------------------------
// sessions/*.json (whole-file, non-jsonl)
// ---------------------------------------------------------------------------

function readSessionJsonWhole(
  text: string,
  relFile: string,
  originPath: string,
  now: () => number,
): { item?: MigrationItem; unimportable: UnimportableEntry[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { unimportable: [{ path: originPath, kind: "session", reason: `session file is not valid JSON: ${(e as Error).message}` }] };
  }

  let rawMessages: unknown[];
  const meta: { id?: string; title?: string; summary?: string; tags?: string[] } = {};
  if (Array.isArray(parsed)) {
    rawMessages = parsed;
  } else if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (!Array.isArray(o.messages)) {
      return { unimportable: [{ path: originPath, kind: "session", reason: 'session JSON object has no "messages" array' }] };
    }
    rawMessages = o.messages;
    if (typeof o.id === "string") meta.id = o.id;
    if (typeof o.title === "string") meta.title = o.title;
    if (typeof o.summary === "string") meta.summary = o.summary;
    if (Array.isArray(o.tags) && o.tags.every((t) => typeof t === "string")) meta.tags = o.tags as string[];
  } else {
    return { unimportable: [{ path: originPath, kind: "session", reason: "session JSON top-level value is neither an array nor an object" }] };
  }

  const messages: ParsedSessionMessage[] = [];
  const unimportable: UnimportableEntry[] = [];
  rawMessages.forEach((entry, idx) => {
    const locator = `${originPath}#[${idx}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      unimportable.push({ path: locator, kind: "session", reason: `message[${idx}] is not a JSON object` });
      return;
    }
    const o = entry as Record<string, unknown>;
    const role = o.role;
    const content = o.content;
    if ((role === "user" || role === "assistant" || role === "system") && typeof content === "string") {
      const ts = parseTimestampFlexible(o.at ?? o.timestamp ?? o.ts, now);
      messages.push({ role, content, at: ts.ms });
      return;
    }
    unimportable.push({ path: locator, kind: "session", reason: `message[${idx}] is not a recognizable {role, content, at?} shape` });
  });

  if (messages.length === 0) {
    unimportable.push({ path: originPath, kind: "session", reason: "no valid messages could be parsed from this session file" });
    return { unimportable };
  }

  const id = meta.id ?? relFile.replace(/\.json$/i, "").split("/").pop() ?? "unknown";
  const startedAt = Math.min(...messages.map((m) => m.at));
  const endedAt = Math.max(...messages.map((m) => m.at));
  const value: JsonValue = {
    id,
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    messages: messages as unknown as JsonValue,
    ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
    tags: meta.tags ?? [],
    startedAt,
    endedAt,
  };
  const item = makeItem({
    kind: "session",
    key: `session:${sanitizeSessionId(id)}`,
    value,
    origin: { path: originPath },
    confidence: unimportable.length === 0 ? 1 : 0.7,
  });
  return { item, unimportable };
}

// ---------------------------------------------------------------------------
// legacy state.json (moltbot flat tool-state)
// ---------------------------------------------------------------------------

function readLegacyStateJson(text: string, relPath: string): { item?: MigrationItem; vaultEntries: SecretVaultEntry[]; unimportable?: UnimportableEntry } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { vaultEntries: [], unimportable: { path: relPath, kind: "tool-state", reason: `state.json is not valid JSON: ${(e as Error).message}` } };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { vaultEntries: [], unimportable: { path: relPath, kind: "tool-state", reason: "state.json top-level value is not a JSON object or array" } };
  }

  const vaultEntries: SecretVaultEntry[] = [];
  let cleaned: JsonValue;
  if (Array.isArray(parsed)) {
    cleaned = sanitizeJsonValue(parsed);
  } else {
    const o = parsed as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && (SECRET_KEY_NAME_RE.test(k) || looksLikeKeyMaterial(v))) {
        const envVar = sanitizeEnvVarName(k);
        vaultEntries.push({ envVar, present: true, redactedPreview: redactPreview(v), value: v, origin: { path: relPath, locator: k } });
        continue;
      }
      out[k] = sanitizeJsonValue(v);
    }
    cleaned = out;
  }

  const item = makeItem({
    kind: "tool-state",
    key: "tool-state:legacy-state",
    value: cleaned,
    origin: { path: relPath },
    confidence: 0.9,
    notes: ["captured verbatim (minus any secret-looking fields, which were moved to the vault) from the legacy moltbot state.json"],
  });
  return { item, vaultEntries };
}

// ---------------------------------------------------------------------------
// readOpenClawSource
// ---------------------------------------------------------------------------

export async function readOpenClawSource(
  source: DiscoveredSource,
  deps: SourceReadDeps,
): Promise<{ bundle: MigrationBundle; secrets: SecretVault }> {
  const now = deps.now;
  const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxItems = deps.maxItems ?? DEFAULT_MAX_ITEMS;

  const items: MigrationItem[] = [];
  const unimportable: UnimportableEntry[] = [];
  const readErrors: ReadErrorEntry[] = [];
  const vaultEntries: SecretVaultEntry[] = [];
  let filesScanned = 0;
  let bytesRead = 0;
  let truncatedAny = false;

  const { files, warnings: walkWarnings } = walkSourceTree(deps.probe, source.root);
  for (const w of walkWarnings) readErrors.push({ path: source.root, reason: w });

  const usedSkillNames = new Set<string>();
  let modelCandidate: { value: string; originPath: string } | undefined;
  let itemCapHit = false;

  ruleLoop: for (const rule of OPENCLAW_ARTIFACTS) {
    const matches = files.filter((f) => ruleMatches(rule, f.relPath)).sort((a, b) => a.relPath.localeCompare(b.relPath));
    for (const f of matches) {
      if (items.length >= maxItems) {
        itemCapHit = true;
        break ruleLoop;
      }
      filesScanned++;
      const wasTruncated = f.bytes > maxFileBytes;
      if (wasTruncated) truncatedAny = true;

      const text = safeReadFile(deps.probe, f.abs, maxFileBytes);
      if (text === undefined) {
        readErrors.push({ path: f.relPath, reason: "could not be read (permission denied, unreadable encoding, or not a regular file)" });
        continue;
      }
      bytesRead += Math.min(f.bytes, maxFileBytes);
      const truncationNote = wasTruncated
        ? [`file is ${f.bytes} bytes, exceeding the ${maxFileBytes}-byte cap; content was truncated before parsing`]
        : [];

      switch (rule.parser) {
        case "openclaw.config.jsonc": {
          let parsed: unknown;
          try {
            parsed = parseJsonc(text);
          } catch (e) {
            unimportable.push({
              path: f.relPath,
              kind: "config",
              reason: `not valid (tolerant) JSONC${wasTruncated ? " (file was truncated at the read cap)" : ""}: ${(e as Error).message}`,
            });
            break;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            unimportable.push({ path: f.relPath, kind: "config", reason: "top-level JSON value is not an object" });
            break;
          }
          const extraction = extractOpenClawConfig(parsed as Record<string, unknown>, f.relPath, "current", "openclaw.json");
          items.push(...extraction.items);
          vaultEntries.push(...extraction.vaultEntries);
          if (extraction.modelCandidate) modelCandidate = extraction.modelCandidate;
          break;
        }
        case "openclaw.config.legacy.clawdbot":
        case "openclaw.config.legacy.moltbot": {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (e) {
            unimportable.push({
              path: f.relPath,
              kind: "config",
              reason: `not valid JSON${wasTruncated ? " (file was truncated at the read cap)" : ""}: ${(e as Error).message}`,
            });
            break;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            unimportable.push({ path: f.relPath, kind: "config", reason: "top-level JSON value is not an object" });
            break;
          }
          const label = rule.parser === "openclaw.config.legacy.clawdbot" ? "clawdbot.json" : "moltbot.json";
          const extraction = extractOpenClawConfig(parsed as Record<string, unknown>, f.relPath, "legacy", label);
          items.push(...extraction.items);
          vaultEntries.push(...extraction.vaultEntries);
          if (extraction.modelCandidate && !modelCandidate) modelCandidate = extraction.modelCandidate;
          break;
        }
        case "dotenv": {
          const result = readDotenvFile(text, f.relPath);
          items.push(...result.items);
          vaultEntries.push(...result.vaultEntries);
          break;
        }
        case "openclaw.agent.json": {
          const result = readAgentJson(text, f.relPath);
          items.push(...result.items);
          vaultEntries.push(...result.vaultEntries);
          if (result.unimportable) unimportable.push(result.unimportable);
          if (result.modelCandidate && !modelCandidate) modelCandidate = result.modelCandidate;
          break;
        }
        case "skill-md": {
          const result = readSkillFile(text, f.relPath, f.relPath, usedSkillNames);
          if (result.item) items.push(result.item);
          if (result.unimportable) unimportable.push(result.unimportable);
          break;
        }
        case "openclaw.memory.md": {
          const result = readMarkdownContextFile(text, f.relPath, f.relPath, now);
          if (wasTruncated) {
            for (const it of result.items) (it.notes ??= []).push(...truncationNote);
          }
          items.push(...result.items);
          unimportable.push(...result.unimportable);
          break;
        }
        case "openclaw.memory.json": {
          const result = readMemoryJsonArray(text, f.relPath, now);
          items.push(...result.items);
          unimportable.push(...result.unimportable);
          break;
        }
        case "openclaw.session.json": {
          const result = readSessionJsonWhole(text, f.relPath, f.relPath, now);
          if (result.item) items.push(result.item);
          unimportable.push(...result.unimportable);
          break;
        }
        case "openclaw.session.jsonl": {
          const result = readSessionJsonl(text, f.relPath, f.relPath, now);
          if (result.item) items.push(result.item);
          unimportable.push(...result.unimportable);
          break;
        }
        case "openclaw.state.json": {
          const result = readLegacyStateJson(text, f.relPath);
          if (result.item) items.push(result.item);
          vaultEntries.push(...result.vaultEntries);
          if (result.unimportable) unimportable.push(result.unimportable);
          break;
        }
        default:
          unimportable.push({ path: f.relPath, kind: rule.kind, reason: `no parser implemented for parser id "${rule.parser}"` });
      }
    }
  }

  if (itemCapHit) {
    readErrors.push({ path: source.root, reason: `item cap of ${maxItems} reached; remaining matched artifacts were not processed` });
  }

  if (modelCandidate) {
    items.push(
      makeItem({
        kind: "model",
        key: "model:selection",
        value: { modelId: modelCandidate.value, evidence: [`modelId read from ${modelCandidate.originPath}`] },
        origin: { path: modelCandidate.originPath },
        confidence: 0.85,
      }),
    );
  }

  const bundle: MigrationBundle = {
    vendor: "openclaw",
    layout: source.layout,
    root: source.root,
    version: source.version,
    items,
    unimportable,
    readErrors,
    stats: { filesScanned, bytesRead, truncated: truncatedAny },
  };
  const secrets: SecretVault = { vendor: "openclaw", entries: vaultEntries };
  return { bundle, secrets };
}
