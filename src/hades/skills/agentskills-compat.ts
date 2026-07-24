/**
 * agentskills.io / open-skill-format compatibility layer.
 *
 * The open `agentskills.io` skill format (the same SKILL.md-with-YAML-
 * frontmatter shape Anthropic's own skills use) and Hades' native SKILL.md
 * format ({@link ../skills/skill-file}) both encode "markdown body + a small
 * frontmatter block", but they use different frontmatter vocabularies:
 *
 *   agentskills.io           Hades ({@link SkillManifest})
 *   ----------------------   ---------------------------------
 *   name                     name
 *   description              description
 *   allowed-tools (list)     tools (list)
 *   license (scalar)         — (no equivalent; dropped, warned)
 *   version (scalar)         version (scalar)
 *   metadata.capabilities    capabilities (list; parsed from a CSV scalar)
 *   metadata.* (other keys)  — (no equivalent; dropped, warned)
 *   (any other key)          — (no equivalent; dropped, warned)
 *   body                     instructions
 *
 * This module is purely format-level: {@link parseAgentSkill} turns raw
 * agentskills.io SKILL.md text into an {@link AgentSkillsManifest}, and
 * {@link toHadesManifest} / {@link fromHadesManifest} convert between that
 * shape and Hades' real {@link SkillManifest} (imported, never re-declared,
 * from {@link ../skills/skill-file}). No filesystem, network, clock, or
 * randomness — fully deterministic and safe to run against untrusted input.
 *
 * The parser below is a deliberately small, tolerant YAML subset — no `yaml`
 * dependency — following the exact discipline of {@link parseSkillFile} in
 * `./skill-file`: normalise line endings, strip a BOM, delimit frontmatter by
 * a leading `---` and the FIRST subsequent `---`, support quoted/bare
 * scalars and inline (`[a, b]`) + block (`- item`) lists. It additionally
 * understands one extra shape agentskills.io frontmatter uses that Hades'
 * own format does not: a single level of nested mapping under the
 * `metadata:` key (`metadata:\n  key: value`). Anything that looks like
 * YAML this parser does not support (nesting under any other key, nesting
 * two levels deep even under `metadata`) is never guessed at or silently
 * mis-parsed — it is skipped and reported as a warning.
 */

import { parseSkillFile, serializeSkillFile, validateSkillManifest } from "./skill-file";
import type { SkillManifest } from "./skill-file";

// ===========================================================================
// public types
// ===========================================================================

/**
 * The open agentskills.io / Anthropic SKILL.md frontmatter shape. `name` and
 * `description` are required (agentskills.io's own contract); everything
 * else is optional. Unknown frontmatter keys — anything this module does not
 * itself understand — are preserved losslessly in `extra` rather than
 * silently dropped, so a round trip through `parseAgentSkill` never loses
 * information the caller did not explicitly choose to drop.
 */
export interface AgentSkillsManifest {
  name: string;
  description: string;
  license?: string;
  version?: string;
  /** From the `allowed-tools` frontmatter key. */
  allowedTools?: string[];
  /** From the nested `metadata:` mapping (one level deep, string values only). */
  metadata?: Record<string, string>;
  /** Every other top-level frontmatter key, preserved verbatim. */
  extra?: Record<string, string | string[]>;
}

export interface AgentSkillParseResult {
  manifest: AgentSkillsManifest;
  body: string;
  warnings: string[];
}

// ===========================================================================
// parseAgentSkill
// ===========================================================================

const KNOWN_SCALAR_KEYS = new Set(["name", "description", "license", "version"]);
const LIST_KEY = "allowed-tools";
const METADATA_KEY = "metadata";

/**
 * Parse an agentskills.io-format SKILL.md document.
 *
 * Frontmatter is delimited by a leading `---` line and the FIRST subsequent
 * `---` line; any `---` inside the body is left untouched. Accepts both LF
 * and CRLF line endings and strips a leading BOM. Bodies of any size
 * (including multi-megabyte bodies) are accepted verbatim — this function
 * does no size enforcement; callers that need byte limits (e.g. the hub
 * package importer) enforce them before calling this.
 *
 * Adversarial frontmatter is handled defensively rather than crashed on or
 * mis-parsed: duplicate keys warn and last-wins; nested mappings under any
 * key other than `metadata`, or nested more than one level even under
 * `metadata`, are rejected with a warning and skipped (never guessed at);
 * stray/inconsistent indentation warns and is skipped. Only a genuinely
 * unparseable line (no `---` fence, no closing fence, or a top-level line
 * that is neither `key: value` nor a list item continuation) throws.
 *
 * @throws {Error} on missing/unterminated frontmatter, a malformed
 *   `key: value` line, or a missing/blank `name` or `description`.
 */
export function parseAgentSkill(content: string): AgentSkillParseResult {
  const warnings: string[] = [];

  const normalized = content.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  if (lines.length === 0 || lines[0].trim() !== "---") {
    throw new Error("agentskills SKILL.md: missing frontmatter — file must start with a `---` line.");
  }

  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    throw new Error("agentskills SKILL.md: unterminated frontmatter — missing the closing `---` line.");
  }

  const fmLines = lines.slice(1, closing);
  const body = lines.slice(closing + 1).join("\n");

  const data: Record<string, string | string[]> = {};
  const seen = new Set<string>();
  let currentListKey: string | null = null;
  let metadataMap: Record<string, string> | undefined;

  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    // Block list item continuation, e.g. `  - value` — attaches to the
    // current list key regardless of its indentation (matches skill-file.ts).
    const blockItem = line.match(/^\s*-(?:\s+(.*))?$/);
    if (blockItem && currentListKey) {
      (data[currentListKey] as string[]).push(parseScalar((blockItem[1] ?? "").trim()));
      i++;
      continue;
    }

    const indent = leadingWhitespaceLen(line);
    if (indent > 0) {
      // Stray indentation not consumed by an active list or the metadata
      // block handler below — reject with a warning rather than guess.
      warnings.push(`ignoring unexpected indented frontmatter line: ${trimmed}`);
      i++;
      continue;
    }

    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`agentskills SKILL.md: malformed frontmatter line (expected \`key: value\`): ${line}`);
    }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (key === "") {
      throw new Error(`agentskills SKILL.md: malformed frontmatter line (empty key): ${line}`);
    }

    if (seen.has(key)) {
      warnings.push(`duplicate frontmatter key "${key}" — later value overwrites the earlier one.`);
    }
    seen.add(key);
    currentListKey = null;

    if (key === METADATA_KEY) {
      if (rest !== "") {
        warnings.push(`"metadata" must be a nested mapping; ignoring inline value: ${rest}`);
        i++;
        continue;
      }
      const result = parseMetadataBlock(fmLines, i + 1);
      metadataMap = { ...(metadataMap ?? {}), ...result.map };
      warnings.push(...result.warnings);
      i = result.nextIndex;
      continue;
    }

    if (key === LIST_KEY) {
      if (rest === "") {
        data[key] = [];
        currentListKey = key;
      } else if (rest.startsWith("[")) {
        data[key] = parseInlineList(rest);
      } else {
        data[key] = [parseScalar(rest)];
      }
      i++;
      continue;
    }

    if (KNOWN_SCALAR_KEYS.has(key)) {
      data[key] = rest === "" ? "" : parseScalar(rest);
      i++;
      continue;
    }

    // Unknown key: could be a scalar, an inline list, a block list (needs a
    // lookahead), or — unsupported — a nested mapping.
    if (rest === "") {
      const next = fmLines[i + 1];
      if (next !== undefined) {
        const nextTrimmed = next.trim();
        const nextIsBlockItem = /^\s*-(?:\s+.*)?$/.test(next);
        const nextIndent = leadingWhitespaceLen(next);
        if (nextIsBlockItem) {
          data[key] = [];
          currentListKey = key;
          i++;
          continue;
        }
        if (nextTrimmed !== "" && !nextTrimmed.startsWith("#") && nextIndent > 0) {
          warnings.push(
            `unsupported nested mapping under frontmatter key "${key}" — ignored (only "metadata" supports nesting).`
          );
          i = skipIndentedBlock(fmLines, i + 1, 0);
          continue;
        }
      }
      data[key] = "";
      i++;
      continue;
    }
    data[key] = rest.startsWith("[") ? parseInlineList(rest) : parseScalar(rest);
    i++;
  }

  const name = typeof data.name === "string" ? data.name : "";
  const description = typeof data.description === "string" ? data.description : "";
  if (!seen.has("name") || name.trim() === "") {
    throw new Error("agentskills SKILL.md: missing required frontmatter field `name`.");
  }
  if (!seen.has("description") || description.trim() === "") {
    throw new Error("agentskills SKILL.md: missing required frontmatter field `description`.");
  }

  const manifest: AgentSkillsManifest = { name, description };
  if (typeof data.license === "string") manifest.license = data.license;
  if (typeof data.version === "string") manifest.version = data.version;
  if (Array.isArray(data[LIST_KEY])) manifest.allowedTools = data[LIST_KEY] as string[];
  if (metadataMap !== undefined) manifest.metadata = metadataMap;

  const extra: Record<string, string | string[]> = {};
  for (const key of Object.keys(data)) {
    if (key === "name" || key === "description" || key === "license" || key === "version" || key === LIST_KEY) {
      continue;
    }
    extra[key] = data[key];
  }
  if (Object.keys(extra).length > 0) manifest.extra = extra;

  return { manifest, body, warnings };
}

/**
 * Parse the indented block that follows a bare `metadata:` line. Only a
 * single level of `key: value` scalar entries is supported (the contracted
 * `Record<string, string>` shape); anything deeper, or a list item, or
 * inconsistent indentation, is rejected with a warning and skipped rather
 * than mis-parsed. Returns the index of the first line NOT part of the block
 * (i.e. the next line to resume the outer parse loop at).
 */
function parseMetadataBlock(
  lines: string[],
  start: number
): { map: Record<string, string>; warnings: string[]; nextIndex: number } {
  const map: Record<string, string> = {};
  const warnings: string[] = [];
  const seenSub = new Set<string>();
  let blockIndent: number | null = null;
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const indent = leadingWhitespaceLen(line);
    if (indent === 0) break; // block ended — resume the outer (top-level) loop here

    if (blockIndent === null) blockIndent = indent;

    if (indent > blockIndent) {
      warnings.push(`unsupported nested mapping inside "metadata" — ignored: ${line.trim()}`);
      i = skipIndentedBlock(lines, i, blockIndent);
      continue;
    }
    if (indent < blockIndent) {
      warnings.push(`inconsistent indentation inside "metadata" — ignored: ${line.trim()}`);
      i++;
      continue;
    }

    if (/^-(?:\s+.*)?$/.test(line.trim())) {
      warnings.push(`"metadata" values must be scalar \`key: value\` pairs — ignored list item: ${line.trim()}`);
      i++;
      continue;
    }

    const colon = line.indexOf(":");
    if (colon === -1) {
      warnings.push(`malformed "metadata" line (expected \`key: value\`) — ignored: ${line.trim()}`);
      i++;
      continue;
    }
    const subKey = line.slice(0, colon).trim();
    const subRest = line.slice(colon + 1).trim();
    if (subKey === "") {
      warnings.push(`malformed "metadata" line (empty key) — ignored: ${line.trim()}`);
      i++;
      continue;
    }

    const next = lines[i + 1];
    if (
      subRest === "" &&
      next !== undefined &&
      next.trim() !== "" &&
      !next.trim().startsWith("#") &&
      leadingWhitespaceLen(next) > blockIndent
    ) {
      warnings.push(`unsupported nested mapping under "metadata.${subKey}" — ignored.`);
      if (seenSub.has(subKey)) {
        warnings.push(`duplicate metadata key "${subKey}" — later value overwrites the earlier one.`);
      }
      seenSub.add(subKey);
      map[subKey] = "";
      i = skipIndentedBlock(lines, i + 1, blockIndent);
      continue;
    }

    if (seenSub.has(subKey)) {
      warnings.push(`duplicate metadata key "${subKey}" — later value overwrites the earlier one.`);
    }
    seenSub.add(subKey);
    map[subKey] = subRest === "" ? "" : parseScalar(subRest);
    i++;
  }

  return { map, warnings, nextIndex: i };
}

/** Skip forward over lines more indented than `minIndent` (blank lines don't break the block). */
function skipIndentedBlock(lines: string[], start: number, minIndent: number): number {
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (leadingWhitespaceLen(line) <= minIndent) break;
    i++;
  }
  return i;
}

function leadingWhitespaceLen(line: string): number {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

// ===========================================================================
// toHadesManifest / fromHadesManifest
// ===========================================================================

/**
 * Convert a parsed {@link AgentSkillsManifest} + body into a Hades
 * {@link SkillManifest}. Field map (agentskills.io -> Hades):
 *
 *   - `name`                       -> `name`
 *   - `description`                -> `description`
 *   - `allowedTools`                -> `tools` (absent -> `[]`)
 *   - `metadata["capabilities"]`   -> `capabilities` (split on `,`, trimmed, empties dropped; absent -> `[]`)
 *   - `version`                     -> `version`
 *   - body                          -> `instructions`
 *
 * Every inbound key that has no home in {@link SkillManifest} — `license`,
 * every `metadata` key other than `capabilities`, and every key in `extra`
 * — produces a named warning (naming the exact key) rather than being
 * silently dropped.
 */
export function toHadesManifest(
  a: AgentSkillsManifest,
  body: string
): { manifest: SkillManifest; warnings: string[] } {
  const warnings: string[] = [];

  const capabilitiesCsv = a.metadata?.["capabilities"];
  const capabilities =
    capabilitiesCsv !== undefined
      ? capabilitiesCsv
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];

  const manifest: SkillManifest = {
    name: a.name,
    description: a.description,
    capabilities,
    tools: a.allowedTools ?? [],
    instructions: body,
  };
  if (a.version !== undefined) manifest.version = a.version;

  if (a.license !== undefined) {
    warnings.push(`agentskills field "license" has no equivalent in SkillManifest; dropped (value: "${a.license}").`);
  }
  if (a.metadata) {
    for (const key of Object.keys(a.metadata)) {
      if (key === "capabilities") continue; // consumed above
      warnings.push(`agentskills metadata key "${key}" has no equivalent in SkillManifest; dropped.`);
    }
  }
  if (a.extra) {
    for (const key of Object.keys(a.extra)) {
      warnings.push(`agentskills frontmatter key "${key}" has no equivalent in SkillManifest; dropped.`);
    }
  }

  // Real validation, not a fabricated pass: the shape assembled above can
  // still be structurally invalid (e.g. `metadata.capabilities` containing
  // duplicate entries after CSV-splitting) — surface that honestly rather
  // than handing back a manifest that will fail the moment something else
  // (SkillLibrary, the hub importer) validates it.
  const validation = validateSkillManifest(manifest);
  if (!validation.valid) {
    for (const e of validation.errors) warnings.push(`converted SkillManifest failed validation: ${e}`);
  }

  return { manifest, warnings };
}

/**
 * Serialize a Hades {@link SkillManifest} into agentskills.io-format
 * SKILL.md text. Field map (Hades -> agentskills.io), the mirror of
 * {@link toHadesManifest}:
 *
 *   - `name`          -> `name`
 *   - `description`   -> `description`
 *   - `tools`          -> `allowed-tools`
 *   - `version`        -> `version`
 *   - `capabilities`   -> `metadata.capabilities` (CSV; omitted when empty)
 *   - `instructions`   -> body
 *
 * `whenToUse` and `model` have no first-class agentskills.io field; they are
 * encoded as top-level extension keys (`when-to-use` / `model`) so a
 * round trip through {@link parseAgentSkill} preserves them in `extra`
 * rather than losing them outright, and a warning names each one that was
 * encoded this way.
 *
 * Name/description/tools/version/capabilities are not taken from `m`
 * directly — they are round-tripped once through Hades' own real
 * {@link serializeSkillFile} + {@link parseSkillFile} first, so this module
 * emits exactly what skill-file.ts actually canonicalizes a manifest to
 * (its exact scalar-quoting/list rules) rather than a hand-rolled
 * approximation of them. The body/instructions are taken from `m` directly
 * (never round-tripped through the parser) so multi-megabyte or
 * CRLF-bearing instruction text is preserved byte-for-byte.
 */
export function fromHadesManifest(m: SkillManifest): { content: string; warnings: string[] } {
  const warnings: string[] = [];

  const validation = validateSkillManifest(m);
  if (!validation.valid) {
    for (const e of validation.errors) warnings.push(`source SkillManifest failed validation: ${e}`);
  }

  // Delegate canonicalization of name/description/tools/version/capabilities
  // to the real Hades serializer + parser rather than re-implementing their
  // quoting/list rules by hand.
  const canonical = parseSkillFile(serializeSkillFile(m)).manifest;

  const fm: string[] = [];
  fm.push(`name: ${scalarOut(canonical.name)}`);
  fm.push(`description: ${scalarOut(canonical.description)}`);
  fm.push(`allowed-tools: ${listOut(canonical.tools ?? [])}`);
  if (canonical.version !== undefined) fm.push(`version: ${scalarOut(canonical.version)}`);
  if ((canonical.capabilities ?? []).length > 0) {
    fm.push(`metadata:`);
    fm.push(`  capabilities: ${scalarOut(canonical.capabilities.join(","))}`);
  }
  if (canonical.whenToUse !== undefined) {
    fm.push(`when-to-use: ${scalarOut(canonical.whenToUse)}`);
    warnings.push(
      `SkillManifest field "whenToUse" has no first-class agentskills.io field; encoded as extension key "when-to-use".`
    );
  }
  if (canonical.model !== undefined) {
    fm.push(`model: ${scalarOut(canonical.model)}`);
    warnings.push(`SkillManifest field "model" has no first-class agentskills.io field; encoded as extension key "model".`);
  }

  const content = `---\n${fm.join("\n")}\n---\n${m.instructions ?? ""}`;
  return { content, warnings };
}

// ===========================================================================
// minimal YAML-subset scalar/list helpers (own copies — see skill-file.ts;
// duplicated here rather than imported since they are not exported there,
// matching this file's house convention of small local helper copies)
// ===========================================================================

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
    if (t === "") continue;
    out.push(parseScalar(t));
  }
  return out;
}

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
