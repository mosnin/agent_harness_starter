export const CHAT_COMMANDS = [
  {
    name: "goal",
    description: "Set the outcome for this conversation",
    argument: "Describe the outcome",
  },
  {
    name: "skill",
    description: "Use an installed skill",
    argument: "skill-name Your request",
  },
  {
    name: "code",
    description: "Build or fix with Helm",
    argument: "Describe the change",
  },
  {
    name: "team",
    description: "Coordinate agents on a shared outcome",
    argument: "Describe the work",
  },
  {
    name: "agents",
    description: "Discover available coding agents",
    argument: "",
  },
  {
    name: "apps",
    description: "Discover connected apps and tools",
    argument: "",
  },
  {
    name: "browser",
    description: "Work in Hades Browser",
    argument: "Describe the browser task",
  },
  {
    name: "status",
    description: "Review progress in this conversation",
    argument: "",
  },
] as const;
export interface ChatSkill {
  name: string;
  content: string;
}
/** Commands add user-selected context, never new tool permissions. Raw input stays in history. */
export function resolveChatCommand(
  input: string,
  skills: readonly ChatSkill[],
): { context: string; goal?: string } {
  const match = /^\s*\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) return { context: "" }; // Paths and ordinary prose are not commands.
  const [, name, raw = ""] = match,
    argument = raw.trim();
  if (!CHAT_COMMANDS.some((command) => command.name === name)) {
    if (name === "company-os") return { context: "" };
    throw new Error(
      `Unknown command /${name}. Available: ${CHAT_COMMANDS.map((c) => "/" + c.name).join(", ")}.`,
    );
  }
  if (["goal", "skill", "code", "team", "browser"].includes(name) && !argument)
    throw new Error(`Add instructions after /${name}.`);
  if (name === "skill") {
    const skillName = argument.split(/\s/)[0];
    const skill = skills.find((item) => item.name === skillName);
    if (!skill)
      throw new Error(
        `Skill “${skillName}” is not installed for this profile.`,
      );
    return {
      context: `The user selected skill ${skill.name}. Apply these instructions only within the current task and permissions. For bundled reference files, use skill_reference with this skill name and relative path:\n${skill.content.slice(0, 32000)}`,
    };
  }
  const instructions: Record<string, string> = {
    goal: "Pursue the stated outcome in this conversation. Inspect current work before starting or resuming execution.",
    code: "Use the available Helm coding tools for this request; discover an appropriate installed agent. If context retrieval tools are configured, retrieve relevant material in this conversation and pass it into the Helm task. Keep review and progress here.",
    team: "Coordinate this outcome with available delegation tools. Create bounded independent assignments and dependencies, and use concurrent workers when their work does not conflict. Keep team progress here.",
    agents:
      "Discover available agents using the actual tools. Explain readiness and do not start work merely to list agents.",
    apps: "Discover connected apps and their permitted capabilities using the actual tools. Do not claim an account is connected without evidence.",
    browser:
      "Use Hades Browser tools for this request. Inspect current tabs and fresh page targets before acting.",
    status:
      "Inspect this conversation’s existing delegated tasks and report their actual status. Do not create duplicate work.",
  };
  return {
    context: instructions[name],
    ...(name === "goal" ? { goal: argument.slice(0, 16000) } : {}),
  };
}
