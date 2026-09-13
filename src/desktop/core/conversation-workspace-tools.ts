import { basename } from 'node:path';
import { workspaceTools } from '../../hades/runtime/tools';
import { createShellTool } from '../../hades/tools/shell';

/** Desktop only: WorkbenchService MUST approve each shell invocation before run.
 * This grants the displayed command, not persistent command/profile permission.
 * The process starts in the project; this is not an OS filesystem sandbox.
 */
export function conversationWorkspaceTools(root: string, commands: string[] = [], signal?: AbortSignal) {
  const tools = workspaceTools(root, commands, signal);
  if (commands.length) return tools;
  tools.register({
    name: 'shell',
    description: 'Propose a local command for inline user approval, then execute it in the conversation project. Input must be JSON {"cmd":string,"args":string[]}. No shell interpretation: use git -C for a repository directory; never combine commands with cd, &&, pipes or redirects. This runs as the local user, not in an OS sandbox. Every call requires approval.',
    run: async (input: string) => {
      let value: {cmd?: unknown; args?: unknown};
      try { value = JSON.parse(input); } catch { return {ok:false,output:'Use JSON {"cmd":string,"args":string[]}.'}; }
      if (!value || typeof value.cmd !== 'string' || !value.cmd.trim() ||
          !Array.isArray(value.args) || !value.args.every(arg => typeof arg === 'string') ||
          Object.keys(value).some(key => !['cmd','args'].includes(key)))
        return {ok:false,output:'Use only cmd and a string args array. The project directory is fixed.'};
      return createShellTool({cwd:root,signal,policy:{allowedCommands:[basename(value.cmd)],timeoutMs:30000,maxOutputBytes:16384}}).tool.run(input);
    },
  });
  return tools;
}
