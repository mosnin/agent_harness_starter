import { describe, expect, it } from "vitest";
import { SkillsService, type SkillsFs } from "../core/skills-service";
import type { Command } from "../ipc/contract";

// ---------------------------------------------------------------------------
// In-memory SkillsFs — deterministic, no real disk touched.
// ---------------------------------------------------------------------------

function memFs(initial?: Record<string, string>): SkillsFs {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  const dirs = new Set<string>();

  function dirOf(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? "" : path.slice(0, idx);
  }
  function baseOf(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? path : path.slice(idx + 1);
  }

  for (const path of files.keys()) dirs.add(dirOf(path));

  return {
    async readDir(dir: string): Promise<string[]> {
      return [...files.keys()].filter((p) => dirOf(p) === dir).map((p) => baseOf(p));
    },
    async readFile(path: string): Promise<string> {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content);
      dirs.add(dirOf(path));
    },
    async mkdirp(dir: string): Promise<void> {
      dirs.add(dir);
    },
    async exists(dir: string): Promise<boolean> {
      return dirs.has(dir) || [...files.keys()].some((p) => dirOf(p) === dir);
    },
  };
}

const VALID_SKILL = `---
name: great skill
description: Does something great.
capabilities: [greatness]
tools: []
---
# great skill

Do the great thing.
`;

const INVALID_SKILL = `Just some markdown with no frontmatter at all.\n`;

describe("SkillsService", () => {
  it("save() writes a valid SKILL.md, then list() shows it", async () => {
    const fs = memFs();
    const svc = new SkillsService({ dir: "/skills", fs });

    const result = await svc.save("great skill", VALID_SKILL);
    expect(result.ok).toBe(true);

    const skills = await svc.list();
    expect(skills).toEqual([{ name: "great skill", description: "Does something great." }]);
  });

  it("save() rejects an invalid SKILL.md with ok:false and a friendly message, and it never shows up in list()", async () => {
    const fs = memFs();
    const svc = new SkillsService({ dir: "/skills", fs });

    const result = await svc.save("bad skill", INVALID_SKILL);
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);

    const skills = await svc.list();
    expect(skills).toEqual([]);
  });

  it("save() never throws even when the fs write fails", async () => {
    const fs = memFs();
    fs.writeFile = async () => {
      throw new Error("disk full");
    };
    const svc = new SkillsService({ dir: "/skills", fs });

    await expect(svc.save("great skill", VALID_SKILL)).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
  });

  it("handle(skills.list) returns a single skills.list AppEvent reflecting the library", async () => {
    const fs = memFs({ "/skills/great-skill.md": VALID_SKILL });
    const svc = new SkillsService({ dir: "/skills", fs });

    const events = await svc.handle({ kind: "skills.list" } as Command);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "skills.list",
      skills: [{ name: "great skill", description: "Does something great." }],
    });
  });

  it("handle(skills.save) with valid content returns a log event and a fresh skills.list event", async () => {
    const fs = memFs();
    const svc = new SkillsService({ dir: "/skills", fs });

    const events = await svc.handle({
      kind: "skills.save",
      name: "great skill",
      content: VALID_SKILL,
    } as Command);

    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("log");
    expect((events[0] as { kind: "log"; line: string }).line).toContain("great skill");
    expect(events[1]).toEqual({
      kind: "skills.list",
      skills: [{ name: "great skill", description: "Does something great." }],
    });
  });

  it("handle(skills.save) with invalid content still returns a log + skills.list, never throws, and the skill isn't listed", async () => {
    const fs = memFs();
    const svc = new SkillsService({ dir: "/skills", fs });

    const events = await svc.handle({
      kind: "skills.save",
      name: "bad skill",
      content: INVALID_SKILL,
    } as Command);

    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("log");
    expect(events[1]).toEqual({ kind: "skills.list", skills: [] });
  });

  it("list() skips a malformed file in the dir alongside a valid one", async () => {
    const fs = memFs({
      "/skills/great-skill.md": VALID_SKILL,
      "/skills/broken.md": INVALID_SKILL,
    });
    const svc = new SkillsService({ dir: "/skills", fs });

    const skills = await svc.list();
    expect(skills).toEqual([{ name: "great skill", description: "Does something great." }]);
  });

  it("save() slugifies the display name into a filesystem-safe filename, independent of the manifest's own name", async () => {
    const fs = memFs();
    const svc = new SkillsService({ dir: "/skills", fs });

    const result = await svc.save("My Great Skill!!", VALID_SKILL);
    expect(result.ok).toBe(true);

    const written = await fs.readFile("/skills/my-great-skill.md");
    expect(written).toContain("name: great skill"); // manifest content wins over the display name
  });

  it("handle() returns [] for a non-skills command", async () => {
    const svc = new SkillsService({ dir: "/skills", fs: memFs() });

    const events = await svc.handle({ kind: "runtime.stop" } as Command);
    expect(events).toEqual([]);
  });
});
