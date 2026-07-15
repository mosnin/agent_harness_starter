/**
 * `hades skill <sub>` — create and manage SKILL.md skills without writing code.
 *
 *   hades skill new <name>       scaffold a ready-to-edit SKILL.md
 *   hades skill list             list skills found in the skills dir
 *   hades skill show <name>      print a skill's manifest + instructions
 *   hades skill validate         validate every SKILL.md in the skills dir
 *
 * Skills live in `$HADES_SKILLS_DIR` (default `<data-dir>/skills`, data-dir
 * `.hades`). File I/O is injectable (`opts.files` / `opts.writeFile`) so this is
 * unit-testable without touching disk; absent injection it uses node:fs.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SkillLibrary } from "../skills/library";
import { parseSkillFile, skillTemplate, validateSkillManifest } from "../skills/skill-file";

export interface SkillCommandResult {
  code: number;
  lines: string[];
}

export interface SkillCommandOptions {
  /** Injected skill files (for tests); absent → read from `dir` via node:fs. */
  files?: Array<{ path: string; content: string }>;
  /** Skills directory; absent → $HADES_SKILLS_DIR or `<HADES_DATA_DIR|.hades>/skills`. */
  dir?: string;
  /** Injected writer (for `new`, tests); absent → node:fs write. */
  writeFile?: (path: string, content: string) => void;
  env?: Record<string, string | undefined>;
}

function skillsDir(opts?: SkillCommandOptions): string {
  if (opts?.dir) return opts.dir;
  const env = opts?.env ?? process.env;
  if (env.HADES_SKILLS_DIR) return env.HADES_SKILLS_DIR;
  return join(env.HADES_DATA_DIR ?? ".hades", "skills");
}

function readFiles(opts: SkillCommandOptions | undefined, dir: string): Array<{ path: string; content: string }> {
  if (opts?.files) return opts.files;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ path: join(dir, f), content: readFileSync(join(dir, f), "utf8") }));
}

const USAGE = [
  "Usage: hades skill <command>",
  "",
  "Commands:",
  "  new <name>     Scaffold a ready-to-edit SKILL.md",
  "  list           List skills in the skills directory",
  "  show <name>    Show a skill's manifest and instructions",
  "  validate       Validate every SKILL.md in the skills directory",
  "  help           Show this help",
  "",
  "Skills dir: $HADES_SKILLS_DIR (default <HADES_DATA_DIR|.hades>/skills).",
  "A skill is a markdown file with frontmatter — no code, no recompile.",
];

export async function runSkillCommand(
  args: string[],
  opts?: SkillCommandOptions
): Promise<SkillCommandResult> {
  const [sub, ...rest] = args;
  const dir = skillsDir(opts);

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: USAGE };
  }

  if (sub === "new") {
    const name = rest[0];
    if (!name) return { code: 1, lines: ["Usage: hades skill new <name>"] };
    const template = skillTemplate(name);
    const target = join(dir, `${name}.md`);
    if (opts?.writeFile) {
      opts.writeFile(target, template);
    } else if (!opts?.files) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(target, template, "utf8");
    }
    return {
      code: 0,
      lines: [`Created skill scaffold: ${target}`, "", ...template.split("\n")],
    };
  }

  const library = new SkillLibrary();
  const report = library.loadFiles(readFiles(opts, dir));

  if (sub === "list") {
    const skills = library.list();
    if (!skills.length) {
      return { code: 0, lines: [`No skills found in ${dir}. Create one with \`hades skill new <name>\`.`] };
    }
    const lines = skills.map(
      (s) => `${s.manifest.name} — ${s.manifest.description} [${s.manifest.capabilities.join(", ") || "no capabilities"}]`
    );
    if (report.errors.length) {
      lines.push("", `${report.errors.length} file(s) failed to load:`);
      for (const e of report.errors) lines.push(`  ${e.path}: ${e.error}`);
    }
    return { code: 0, lines };
  }

  if (sub === "show") {
    const name = rest[0];
    if (!name) return { code: 1, lines: ["Usage: hades skill show <name>"] };
    const s = library.get(name);
    if (!s) return { code: 1, lines: [`No skill named "${name}" in ${dir}.`] };
    const m = s.manifest;
    return {
      code: 0,
      lines: [
        `name:         ${m.name}`,
        `description:  ${m.description}`,
        `capabilities: ${m.capabilities.join(", ")}`,
        `tools:        ${m.tools.join(", ") || "(none)"}`,
        ...(m.whenToUse ? [`when to use:  ${m.whenToUse}`] : []),
        ...(m.version ? [`version:      ${m.version}`] : []),
        "",
        "instructions:",
        ...m.instructions.split("\n").map((l) => `  ${l}`),
      ],
    };
  }

  if (sub === "validate") {
    const lines: string[] = [];
    let bad = 0;
    for (const loaded of library.list()) {
      const v = validateSkillManifest(loaded.manifest);
      if (v.valid) {
        lines.push(`OK    ${loaded.manifest.name}`);
      } else {
        bad++;
        lines.push(`FAIL  ${loaded.path}: ${v.errors.join("; ")}`);
      }
    }
    for (const e of report.errors) {
      bad++;
      lines.push(`FAIL  ${e.path}: ${e.error}`);
    }
    if (!lines.length) return { code: 0, lines: [`No skills found in ${dir}.`] };
    lines.push("", bad === 0 ? "All skills valid." : `${bad} skill(s) invalid.`);
    return { code: bad === 0 ? 0 : 1, lines };
  }

  return { code: 1, lines: [`Unknown skill command: ${sub}`, "Run `hades skill help` for usage."] };
}
