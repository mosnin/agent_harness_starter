/**
 * SKILL.md — a portable, human-authorable skill format for Hades.
 *
 * A SKILL.md file is markdown with a YAML-ish frontmatter block at the top,
 * delimited by a leading `---` line and a closing `---` line. Everything after
 * the closing delimiter is the markdown body, which becomes the worker's
 * `instructions` (and, once bound, the skill's `promptFragment`).
 *
 * This lets anyone create a skill — routing capabilities, a tool allowlist, and
 * behavioural instructions — without writing TypeScript or recompiling, the same
 * way Hermes' agentskills.io / SKILL.md format works. A parsed {@link SkillManifest}
 * converts into the swarm's existing {@link SwarmSkill} shape via {@link toSwarmSkill}.
 *
 * The parser implements a deliberately small, deterministic YAML subset — no
 * `yaml` dependency, no filesystem, no clock/network/randomness — so behaviour is
 * fully reproducible and safe to run against untrusted input.
 */

import type { SwarmSkill } from "../../swarm-runtime/skills/skill";
import type { SwarmTool } from "../../swarm-runtime/worker/toolbox";

export interface SkillManifest {
  name: string;
  description: string;
  capabilities: string[]; // for routing + tool allowlisting
  tools: string[]; // names of tools to bind from a provided registry
  whenToUse?: string; // guidance for when a worker should adopt this skill
  model?: string;
  version?: string;
  instructions: string; // the markdown body — becomes the worker prompt fragment
}

export interface ParseResult {
  manifest: SkillManifest;
  warnings: string[];
}

/** Frontmatter keys that always carry list values. */
const LIST_KEYS = new Set(["capabilities", "tools"]);
/** Frontmatter keys that always carry scalar (string) values. */
const SCALAR_KEYS = new Set(["name", "description", "whenToUse", "model", "version"]);

/**
 * Parse a SKILL.md document.
 *
 * Frontmatter is delimited by a leading `---` line and the FIRST subsequent
 * `---` line; any `---` inside the body is left untouched. Supports `key: value`
 * scalars (quoted or bare), inline lists (`[a, b]`), and block lists (`- item`).
 * Accepts both LF and CRLF line endings.
 *
 * @throws {Error} on malformed frontmatter or missing required fields (name, description).
 */
export function parseSkillFile(content: string): ParseResult {
  const warnings: string[] = [];

  // Normalise line endings and strip a leading BOM. Deterministic; no locale.
  const normalized = content.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  if (lines.length === 0 || lines[0].trim() !== "---") {
    throw new Error("SKILL.md: missing frontmatter — file must start with a `---` line.");
  }

  // The FIRST `---` after line 0 closes the frontmatter; the body may contain more.
  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    throw new Error("SKILL.md: unterminated frontmatter — missing the closing `---` line.");
  }

  const frontmatterLines = lines.slice(1, closing);
  const body = lines.slice(closing + 1).join("\n");

  const data: Record<string, string | string[]> = {};
  const seen = new Set<string>();
  let currentListKey: string | null = null;

  for (const line of frontmatterLines) {
    const trimmed = line.trim();
    if (trimmed === "") continue; // blank
    if (trimmed.startsWith("#")) continue; // full-line comment

    // Block list item, e.g. `  - value` — attaches to the current list key.
    const blockItem = line.match(/^\s*-(?:\s+(.*))?$/);
    if (blockItem && currentListKey) {
      const arr = data[currentListKey] as string[];
      arr.push(parseScalar((blockItem[1] ?? "").trim()));
      continue;
    }

    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`SKILL.md: malformed frontmatter line (expected \`key: value\`): ${line}`);
    }

    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (LIST_KEYS.has(key)) {
      seen.add(key);
      currentListKey = key;
      if (rest === "") {
        data[key] = (data[key] as string[]) ?? []; // block items may follow
      } else if (rest.startsWith("[")) {
        data[key] = parseInlineList(rest);
      } else {
        // Lenient: a bare scalar on a list key becomes a single-element list.
        data[key] = [parseScalar(rest)];
      }
    } else if (SCALAR_KEYS.has(key)) {
      seen.add(key);
      currentListKey = null;
      data[key] = parseScalar(rest);
    } else {
      currentListKey = null;
      warnings.push(`unknown frontmatter key ignored: ${key}`);
    }
  }

  if (!seen.has("name") || typeof data.name !== "string" || data.name.trim() === "") {
    throw new Error("SKILL.md: missing required frontmatter field `name`.");
  }
  if (!seen.has("description") || typeof data.description !== "string" || data.description.trim() === "") {
    throw new Error("SKILL.md: missing required frontmatter field `description`.");
  }

  const manifest: SkillManifest = {
    name: data.name as string,
    description: data.description as string,
    capabilities: (data.capabilities as string[] | undefined) ?? [],
    tools: (data.tools as string[] | undefined) ?? [],
    instructions: body,
  };
  if (seen.has("whenToUse")) manifest.whenToUse = data.whenToUse as string;
  if (seen.has("model")) manifest.model = data.model as string;
  if (seen.has("version")) manifest.version = data.version as string;

  return { manifest, warnings };
}

/**
 * Serialize a manifest to canonical SKILL.md text.
 * Invariant: `parseSkillFile(serializeSkillFile(m)).manifest` deep-equals `m`.
 */
export function serializeSkillFile(manifest: SkillManifest): string {
  const fm: string[] = [];
  fm.push(`name: ${scalarOut(manifest.name)}`);
  fm.push(`description: ${scalarOut(manifest.description)}`);
  fm.push(`capabilities: ${listOut(manifest.capabilities ?? [])}`);
  fm.push(`tools: ${listOut(manifest.tools ?? [])}`);
  if (manifest.whenToUse !== undefined) fm.push(`whenToUse: ${scalarOut(manifest.whenToUse)}`);
  if (manifest.model !== undefined) fm.push(`model: ${scalarOut(manifest.model)}`);
  if (manifest.version !== undefined) fm.push(`version: ${scalarOut(manifest.version)}`);

  return `---\n${fm.join("\n")}\n---\n${manifest.instructions ?? ""}`;
}

export interface ManifestValidation {
  valid: boolean;
  errors: string[];
}

/** Validate a (possibly partial) manifest: required fields, empty entries, duplicates. */
export function validateSkillManifest(m: Partial<SkillManifest>): ManifestValidation {
  const errors: string[] = [];

  if (typeof m.name !== "string" || m.name.trim() === "") {
    errors.push("name is required and must be a non-empty string.");
  }
  if (typeof m.description !== "string" || m.description.trim() === "") {
    errors.push("description is required and must be a non-empty string.");
  }

  checkList("capabilities", m.capabilities, errors);
  checkList("tools", m.tools, errors);

  for (const opt of ["whenToUse", "model", "version"] as const) {
    const v = m[opt];
    if (v !== undefined && typeof v !== "string") {
      errors.push(`${opt} must be a string when present.`);
    }
  }
  if (m.instructions !== undefined && typeof m.instructions !== "string") {
    errors.push("instructions must be a string when present.");
  }

  return { valid: errors.length === 0, errors };
}

function checkList(field: "capabilities" | "tools", value: unknown, errors: string[]): void {
  if (value === undefined) return; // empty/absent lists are allowed
  const singular = field === "capabilities" ? "capability" : "tool";
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings.`);
    return;
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      errors.push(`${field} contains an empty or non-string entry.`);
      continue;
    }
    if (seen.has(entry)) errors.push(`duplicate ${singular}: ${entry}`);
    seen.add(entry);
  }
}

/**
 * Bind a manifest's tool NAMES against a lookup, producing a {@link SwarmSkill}
 * whose `promptFragment` is the manifest instructions. Unknown tool names are
 * collected and (unless `opts.allowMissingTools`) raise a clear Error.
 */
export function toSwarmSkill(
  manifest: SkillManifest,
  tools: { get(name: string): unknown } | Map<string, unknown>,
  opts?: { allowMissingTools?: boolean }
): { skill: SwarmSkill; missingTools: string[] } {
  const bound: SwarmTool[] = [];
  const missingTools: string[] = [];

  for (const name of manifest.tools ?? []) {
    const found = tools.get(name);
    if (found === undefined || found === null) {
      missingTools.push(name);
      continue;
    }
    bound.push(found as SwarmTool);
  }

  if (missingTools.length > 0 && !opts?.allowMissingTools) {
    throw new Error(
      `SKILL.md "${manifest.name}": unknown tool(s) not found in registry: ${missingTools.join(", ")}`
    );
  }

  const skill: SwarmSkill = {
    name: manifest.name,
    description: manifest.description,
    capabilities: manifest.capabilities ?? [],
    tools: bound,
    promptFragment: manifest.instructions,
  };

  return { skill, missingTools };
}

/** A ready-to-edit SKILL.md scaffold for a new skill of the given name. */
export function skillTemplate(name: string): string {
  const manifest: SkillManifest = {
    name,
    description: "TODO: one-line description of what this skill does.",
    capabilities: [],
    tools: [],
    whenToUse: "TODO: describe when a worker should adopt this skill.",
    version: "0.1.0",
    instructions: `# ${name}\n\nTODO: write the worker instructions in markdown.\n\nExplain the goal, the approach, and how to use the bound tools.\n`,
  };
  return serializeSkillFile(manifest);
}

// ── Minimal YAML-subset scalar/list helpers ──────────────────────────────────

/** Parse a single frontmatter scalar: bare, double-quoted, or single-quoted. */
function parseScalar(raw: string): string {
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
    }
  }
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

/** Parse an inline list `[a, "b, c", d]` into string items. */
function parseInlineList(rest: string): string[] {
  const open = rest.indexOf("[");
  const close = rest.lastIndexOf("]");
  const inner = close > open ? rest.slice(open + 1, close) : rest.slice(open + 1);

  const items: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') {
        // Preserve the escaped char verbatim; parseScalar re-parses it.
        cur += inner[i + 1] ?? "";
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ",") {
      items.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  items.push(cur);

  const out: string[] = [];
  for (const tok of items) {
    const t = tok.trim();
    if (t === "") continue; // empty list, or trailing comma
    out.push(parseScalar(t));
  }
  return out;
}

/** Emit a scalar, quoting only when a bare value would not round-trip. */
function scalarOut(v: string): string {
  const value = v ?? "";
  const needsQuote =
    value === "" ||
    /^\s|\s$/.test(value) ||
    value.includes("\n") ||
    value.startsWith('"') ||
    value.startsWith("'");
  return needsQuote ? JSON.stringify(value) : value;
}

/** Emit an inline list, quoting items that contain separators or edge whitespace. */
function listOut(arr: string[]): string {
  if (arr.length === 0) return "[]";
  return `[${arr.map(itemOut).join(", ")}]`;
}

function itemOut(v: string): string {
  const value = v ?? "";
  const needsQuote =
    value === "" ||
    /^\s|\s$/.test(value) ||
    value.includes("\n") ||
    value.includes(",") ||
    value.includes("[") ||
    value.includes("]") ||
    value.startsWith('"') ||
    value.startsWith("'");
  return needsQuote ? JSON.stringify(value) : value;
}
