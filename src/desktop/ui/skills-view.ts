/**
 * Hades desktop skills view.
 *
 * Lets a user author and manage SKILL.md skills without writing code: a list
 * of installed skills on the left, a New skill affordance, and an editor pane
 * on the right that live validates whatever SKILL.md text is in it using the
 * REAL skill library (`src/hades/skills/skill-file.ts`) — no duplicate parser,
 * no simulated validation.
 *
 * Pure render functions: string in, string out. No DOM, no framework, no I/O.
 * Every render function escapes dynamic text before it reaches the markup.
 */

import type { AppState } from "../core/app-store";
import { parseSkillFile, validateSkillManifest, skillTemplate } from "../../hades/skills/skill-file";

export interface SkillEditorStatus {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Escape text for safe use inside HTML markup (element content and attributes alike). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Skill list
// ---------------------------------------------------------------------------

/** Renders one card per installed skill: name, description. Escapes both. */
export function renderSkillList(skills: Array<{ name: string; description: string }>): string {
  if (skills.length === 0) {
    return (
      '<div class="skills view empty">' +
      '<p class="skills view empty text">No skills installed yet. Create one to get started.</p>' +
      "</div>"
    );
  }

  const cards = skills
    .map((skill) => {
      const name = escapeHtml(skill.name);
      const description = escapeHtml(skill.description);
      return (
        `<article class="skill card" data-cmd="skills.open" data-skill-name="${name}">` +
        `<header class="skill card header">` +
        `<span class="skill card name">${name}</span>` +
        `</header>` +
        `<p class="skill card description">${description}</p>` +
        `</article>`
      );
    })
    .join("");

  return `<div class="skill list">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// Editor status (live validation via the real skill library)
// ---------------------------------------------------------------------------

/** Strip the leading "SKILL.md: " context tag the library prefixes onto errors, for friendlier UI copy. */
function friendlyMessage(raw: string): string {
  const stripped = raw.replace(/^SKILL\.md:\s*/, "");
  return stripped.length > 0 ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : raw;
}

/**
 * Parses and validates SKILL.md text via the real `parseSkillFile` /
 * `validateSkillManifest` library functions and returns a friendly status.
 * Never throws: parse failures and validation failures both become
 * `{ ok: false, message }`.
 */
export function editorStatus(content: string): SkillEditorStatus {
  let manifest;
  try {
    manifest = parseSkillFile(content).manifest;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, message: friendlyMessage(raw) };
  }

  const validation = validateSkillManifest(manifest);
  if (!validation.valid) {
    const first = validation.errors[0] ?? "This skill is invalid.";
    return { ok: false, message: friendlyMessage(first) };
  }

  return { ok: true, message: `Valid skill: ${manifest.name}` };
}

// ---------------------------------------------------------------------------
// Editor pane
// ---------------------------------------------------------------------------

/** A SKILL.md editor: the raw text plus a live validated status line and a Save affordance. */
export function renderSkillEditor(content: string): string {
  const status = editorStatus(content);
  const statusClass = status.ok ? "skill editor status ok" : "skill editor status bad";
  const statusIcon = status.ok ? "✓" : "✕";

  return (
    '<div class="skill editor">' +
    '<div class="skill editor toolbar">' +
    '<span class="skill editor label">SKILL.md</span>' +
    `<button type="button" class="skill editor save" data-cmd="skills.save">Save</button>` +
    "</div>" +
    '<textarea class="skill editor textarea" data-field="skill.content" spellcheck="false" rows="20">' +
    escapeHtml(content) +
    "</textarea>" +
    `<div class="${statusClass}">` +
    `<span class="skill editor status icon">${statusIcon}</span>` +
    `<span class="skill editor status message">${escapeHtml(status.message)}</span>` +
    "</div>" +
    "</div>"
  );
}

// ---------------------------------------------------------------------------
// New skill scaffold
// ---------------------------------------------------------------------------

/** A ready to edit SKILL.md scaffold for a new skill of the given name, via the real template. */
export function newSkillTemplate(name: string): string {
  return skillTemplate(name);
}

// ---------------------------------------------------------------------------
// Top level view
// ---------------------------------------------------------------------------

/**
 * The full skills view: installed skills (list + New skill affordance) on the
 * left, an editor pane on the right. `AppState.skills` only carries name and
 * description (the sidecar's `skills.list` event shape) so the editor pane
 * opens onto a fresh scaffold; opening an existing skill's full SKILL.md text
 * for editing is driven by a `skills.open` command handled outside this pure
 * render layer.
 */
export function renderSkillsView(state: AppState): string {
  const list = renderSkillList(state.skills);
  const editor = renderSkillEditor(newSkillTemplate("new skill"));

  return (
    '<div class="skills view">' +
    '<section class="skills view sidebar">' +
    '<header class="skills view sidebar header">' +
    '<span class="skills view title">Skills</span>' +
    '<button type="button" class="skills view new button" data-cmd="skills.new">New skill</button>' +
    "</header>" +
    list +
    "</section>" +
    '<section class="skills view main">' +
    editor +
    "</section>" +
    "</div>"
  );
}
