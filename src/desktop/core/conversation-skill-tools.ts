import bundle from "../../../third_party/conversation-skills/bundle.json";
import type { Tool } from "../../hades/agent/tools";
export function conversationSkillTools(): Tool[] {
  const parse = (input: string) => {
    const value = JSON.parse(input);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !["skill", "path", "offset"].includes(key),
      )
    )
      throw new Error("Provide skill, relative path and optional offset");
    const skill = bundle.skills.find((s) => s.name === value.skill);
    if (!skill) throw new Error("Bundled skill not found");
    const file = skill.references.find((f) => f.path === value.path);
    if (!file)
      throw new Error(
        "Reference not found; available: " +
          skill.references.map((f) => f.path).join(", "),
      );
    const offset = value.offset ?? 0;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > file.content.length
    )
      throw new Error("Invalid offset");
    return { file, offset };
  };
  return [
    {
      name: "skill_reference",
      description:
        'Read exact bundled skill reference material without running it. JSON {"skill":string,"path":string,"offset"?:number}. Paths are relative to the selected bundled skill; arbitrary filesystem paths are not accepted. Output is paginated at 16,000 characters.',
      validate(input) {
        try {
          parse(input);
        } catch (error) {
          return String(error instanceof Error ? error.message : error);
        }
      },
      async run(input) {
        const { file, offset } = parse(input);
        return {
          ok: true,
          output: JSON.stringify({
            path: file.path,
            content: file.content.slice(offset, offset + 16000),
            nextOffset:
              offset + 16000 < file.content.length ? offset + 16000 : null,
          }),
        };
      },
    },
  ];
}
