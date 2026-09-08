import { builtinRegistry, type ToolRegistry } from "../agent/tools";
import { createFileOpsTool } from "../tools/file-ops";
import { createShellTool } from "../tools/shell";

/** Files are confined by the file tool's root checks. Shell is opt-in and is
 * NOT an OS sandbox; an allowed interpreter can access the host as this user. */
export function workspaceTools(root: string, shellCommands: string[] = [], signal?: AbortSignal): ToolRegistry {
  const tools = builtinRegistry();
  tools.register(createFileOpsTool({ root }).tool);
  if (shellCommands.length) tools.register(createShellTool({ cwd: root, signal, policy: { allowedCommands: shellCommands, timeoutMs: 30_000, maxOutputBytes: 16_384 } }).tool);
  return tools;
}
