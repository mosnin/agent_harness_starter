/**
 * Skills service — the desktop app's `skills.list` / `skills.save` backend.
 *
 * The Tauri renderer's Skills view sends {@link Command}s for listing and
 * saving SKILL.md files; this module handles them against the real SKILL.md
 * library (`src/hades/skills/library.ts`, `src/hades/skills/skill-file.ts`)
 * and a real (or injected) filesystem, translating the result into
 * {@link AppEvent}s.
 *
 * File I/O is injected via {@link SkillsFs} — the same pattern the rest of
 * `src/desktop/core` uses (see `Sidecar`'s injected `SwarmFactory`) — so this
 * is fully unit-testable with an in-memory fake and never has to touch disk
 * in tests. `nodeSkillsFs()` supplies the real `node:fs/promises` adapter for
 * production use.
 */

import { join } from "node:path";
import { SkillLibrary } from "../../hades/skills/library";
import {
  parseSkillFile,
  serializeSkillFile,
  validateSkillManifest,
  type SkillManifest,
} from "../../hades/skills/skill-file";
import type { AppEvent, Command } from "../ipc/contract";

// ---------------------------------------------------------------------------
// Injectable filesystem
// ---------------------------------------------------------------------------

export interface SkillsFs {
  /** List filenames (not full paths) directly inside `dir`. */
  readDir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  exists(dir: string): Promise<boolean>;
}

/** Real `node:fs/promises`-backed {@link SkillsFs} for production use. */
export function nodeSkillsFs(): SkillsFs {
  return {
    async readDir(dir: string): Promise<string[]> {
      const fs = await import("node:fs/promises");
      return fs.readdir(dir);
    },
    async readFile(path: string): Promise<string> {
      const fs = await import("node:fs/promises");
      return fs.readFile(path, "utf8");
    },
    async writeFile(path: string, content: string): Promise<void> {
      const fs = await import("node:fs/promises");
      await fs.writeFile(path, content, "utf8");
    },
    async mkdirp(dir: string): Promise<void> {
      const fs = await import("node:fs/promises");
      await fs.mkdir(dir, { recursive: true });
    },
    async exists(dir: string): Promise<boolean> {
      const fs = await import("node:fs/promises");
      try {
        await fs.access(dir);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface SkillsServiceOptions {
  /** Skills directory; defaults to `$HADES_SKILLS_DIR` or `<HADES_DATA_DIR|.hades>/skills`. */
  dir?: string;
  /** Injected filesystem; defaults to {@link nodeSkillsFs}. */
  fs?: SkillsFs;
  env?: Record<string, string | undefined>;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

function defaultDir(env: Record<string, string | undefined>): string {
  if (env.HADES_SKILLS_DIR) return env.HADES_SKILLS_DIR;
  return join(env.HADES_DATA_DIR ?? ".hades", "skills");
}

/** Turn a skill name into a filesystem-safe kebab-case slug for its filename. */
function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "skill";
}

export class SkillsService {
  private readonly dir: string;
  private readonly fs: SkillsFs;

  constructor(opts?: SkillsServiceOptions) {
    const env = opts?.env ?? process.env;
    this.dir = opts?.dir ?? defaultDir(env);
    this.fs = opts?.fs ?? nodeSkillsFs();
  }

  /**
   * Handle a skills `Command`, returning the `AppEvent`s to emit. Non-skills
   * commands produce no events. Never throws — any failure becomes a `log`
   * event instead.
   */
  async handle(cmd: Command): Promise<AppEvent[]> {
    try {
      switch (cmd.kind) {
        case "skills.list": {
          const skills = await this.list();
          return [{ kind: "skills.list", skills }];
        }
        case "skills.save": {
          const result = await this.save(cmd.name, cmd.content);
          const skills = await this.list();
          return [
            { kind: "log", line: result.message, at: Date.now() },
            { kind: "skills.list", skills },
          ];
        }
        default:
          return [];
      }
    } catch (err) {
      return [{ kind: "log", line: `skills-service error: ${errMsg(err)}`, at: Date.now() }];
    }
  }

  /** List every valid `*.md` skill in the skills dir as name+description. Malformed files are skipped. */
  async list(): Promise<Array<{ name: string; description: string }>> {
    const files = await this.readMdFiles();
    const library = new SkillLibrary();
    const report = library.loadFiles(files);
    void report; // errors deliberately silent here — a malformed file just doesn't list
    return library.list().map((s) => ({ name: s.manifest.name, description: s.manifest.description }));
  }

  /**
   * Validate `content` as a SKILL.md, and if valid, write it to
   * `<dir>/<slug(name)>.md` (creating the dir if needed). Returns a friendly
   * ok/error result; never throws.
   */
  async save(name: string, content: string): Promise<{ ok: boolean; message: string }> {
    let manifest: SkillManifest;
    try {
      const parsed = parseSkillFile(content);
      manifest = parsed.manifest;
    } catch (err) {
      return { ok: false, message: `Could not save skill "${name}": ${errMsg(err)}` };
    }

    const validation = validateSkillManifest(manifest);
    if (!validation.valid) {
      return {
        ok: false,
        message: `Could not save skill "${name}": ${validation.errors.join("; ")}`,
      };
    }

    const target = join(this.dir, `${slug(name)}.md`);
    try {
      await this.fs.mkdirp(this.dir);
      await this.fs.writeFile(target, serializeSkillFile(manifest));
    } catch (err) {
      return { ok: false, message: `Could not save skill "${name}": ${errMsg(err)}` };
    }

    return { ok: true, message: `Saved skill "${manifest.name}" to ${target}.` };
  }

  private async readMdFiles(): Promise<Array<{ path: string; content: string }>> {
    if (!(await this.fs.exists(this.dir))) return [];
    const names = (await this.fs.readDir(this.dir)).filter((f) => f.endsWith(".md"));
    const files: Array<{ path: string; content: string }> = [];
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        files.push({ path, content: await this.fs.readFile(path) });
      } catch {
        // Unreadable file: skip it rather than fail the whole listing.
      }
    }
    return files;
  }
}
