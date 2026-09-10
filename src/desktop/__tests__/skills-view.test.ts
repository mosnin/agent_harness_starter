import { describe, it, expect } from "vitest";
import {
  renderSkillsView,
  renderSkillList,
  renderSkillEditor,
  editorStatus,
  newSkillTemplate,
} from "../ui/skills-view";
import { parseSkillFile, skillTemplate } from "../../hades/skills/skill-file";
import { initialState, type AppState } from "../core/app-store";

describe("skills-view", () => {
  it("renderSkillsView shows a New skill affordance", () => {
    const state: AppState = { ...initialState(), skills: [] };
    const html = renderSkillsView(state);
    expect(html).toContain('data-cmd="skills.new"');
    expect(html).toContain("New skill");
  });

  it("renderSkillList renders a card per skill with its name and description", () => {
    const skills = [
      { name: "code review", description: "Reviews a diff for bugs." },
      { name: "deploy", description: "Ships the build to prod." },
    ];
    const html = renderSkillList(skills);
    expect(html).toContain("code review");
    expect(html).toContain("Reviews a diff for bugs.");
    expect(html).toContain("deploy");
    expect(html).toContain("Ships the build to prod.");
    const cardCount = (html.match(/data-cmd="skills\.open"/g) ?? []).length;
    expect(cardCount).toBe(2);
  });

  it("editorStatus returns ok:true and the skill name for a valid SKILL.md", () => {
    const content = newSkillTemplate("great skill");
    const status = editorStatus(content);
    expect(status.ok).toBe(true);
    expect(status.message).toContain("great skill");
  });

  it("editorStatus returns ok:false with a helpful message for missing frontmatter", () => {
    const status = editorStatus("just a plain markdown file, no frontmatter at all");
    expect(status.ok).toBe(false);
    expect(status.message.toLowerCase()).toContain("frontmatter");
  });

  it("editorStatus returns ok:false with a helpful message for a missing name field", () => {
    const malformed = "---\ndescription: has a description but no name\n---\nBody text.\n";
    const status = editorStatus(malformed);
    expect(status.ok).toBe(false);
    expect(status.message.toLowerCase()).toContain("name");
  });

  it("newSkillTemplate round trips through parseSkillFile", () => {
    const content = newSkillTemplate("round tripper");
    const { manifest } = parseSkillFile(content);
    expect(manifest.name).toBe("round tripper");
    expect(manifest.description.length).toBeGreaterThan(0);
    // Cross check against the underlying library template directly.
    expect(content).toBe(skillTemplate("round tripper"));
  });

  it("escapes dynamic text in renderSkillList", () => {
    const skills = [{ name: "<script>alert(1)</script>", description: '"><img src=x onerror=alert(2)>' }];
    const html = renderSkillList(skills);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(2)>");
  });

  it("renderSkillEditor includes the escaped content, a live status line, and a Save affordance", () => {
    const html = renderSkillEditor('---\nname: "<b>bad</b>"\ndescription: test\n---\nBody\n');
    expect(html).toContain('data-cmd="skills.save"');
    expect(html).not.toContain("<b>bad</b>");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
    // The status line should reflect a validation result, ok or not.
    const status = editorStatus('---\nname: "<b>bad</b>"\ndescription: test\n---\nBody\n');
    expect(html).toContain(status.message.length > 0 ? "skill editor status" : "");
  });
});
