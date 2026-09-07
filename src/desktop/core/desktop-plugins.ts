import type { DesktopMcpServer } from "./mcp-stdio";
export interface DesktopPlugin {
  format: "hades-plugin-v1";
  name: string;
  version: string;
  description: string;
  skills: Array<{ name: string; content: string }>;
  mcp: DesktopMcpServer[];
}
export function parseDesktopPlugin(content: unknown): DesktopPlugin {
  if (typeof content !== "string" || content.length > 250_000)
    throw new Error("Plugin file is limited to 250 KB");
  const p = JSON.parse(content);
  const name = (s: unknown) => {
    if (typeof s !== "string" || !/^[a-z][a-z0-9-]{0,35}$/.test(s))
      throw new Error(
        "Plugin and component names must be lowercase letters, digits and hyphens (36 characters maximum)",
      );
    return s;
  };
  const text = (s: unknown, max: number) => {
    if (typeof s !== "string" || s.length > max)
      throw new Error("Invalid plugin text");
    return s;
  };
  if (p.format !== "hades-plugin-v1")
    throw new Error("Choose a hades-plugin-v1 manifest");
  if (
    !Array.isArray(p.skills ?? []) ||
    (p.skills ?? []).length > 10 ||
    !Array.isArray(p.mcp ?? []) ||
    (p.mcp ?? []).length > 5
  )
    throw new Error("Plugin supports up to ten skills and five MCP servers");
  const plugin: DesktopPlugin = {
    format: p.format,
    name: name(p.name),
    version: text(p.version, 40),
    description: text(p.description ?? "", 1000),
    skills: (p.skills ?? []).map((s: any) => ({
      name: name(s.name),
      content: text(s.content, 16000),
    })),
    mcp: (p.mcp ?? []).map((s: any) => {
      if (!Array.isArray(s.args ?? []) || (s.args ?? []).length > 50)
        throw new Error("Invalid MCP arguments");
      const command = text(s.command, 4096);
      if (!command.trim()) throw new Error("MCP command is required");
      return {
        name: name(s.name),
        command,
        args: (s.args ?? []).map((a: unknown) => text(a, 4096)),
        enabled: false,
      };
    }),
  };
  if (!plugin.skills.length && !plugin.mcp.length)
    throw new Error("Plugin must include a skill or MCP server");
  for (const list of [plugin.skills, plugin.mcp])
    if (new Set(list.map((x) => x.name)).size !== list.length)
      throw new Error("Duplicate component name");
  return plugin;
}
