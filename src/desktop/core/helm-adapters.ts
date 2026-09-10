import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { HelmAgentId } from './helm-types.js';
export const HELM_AGENTS: HelmAgentId[] = ['hades', 'codex', 'claude', 'gemini', 'opencode', 'grok'];
export function helmEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PATH: [...(env.PATH ?? '').split(delimiter), join(homedir(), '.local/bin'), join(homedir(), '.opencode/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(delimiter), ...(env.HADES_CODEX_HOME ? { CODEX_HOME: env.HADES_CODEX_HOME } : {}) };
}
export function helmBinary(id: HelmAgentId, env: NodeJS.ProcessEnv): string | undefined {
  if (id === 'hades') return undefined;
  const override = env[`HADES_HELM_${id.toUpperCase()}_BIN`] ?? (id === 'codex' ? env.HADES_CODEX_BIN : undefined);
  const candidates = override ? [override] : (helmEnv(env).PATH ?? '').split(delimiter).map(p => join(p, id));
  return candidates.find(p => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } });
}
// Official CLI contracts: code.claude.com/docs/en/cli-usage,
// developers.openai.com/codex/cli/reference, geminicli.com/docs/reference/configuration,
// opencode.ai/docs/cli, github.com/xai-org/grok-build (headless user guide).
// Keep permission checks active. These modes permit edits, not arbitrary approval bypass.
export function helmCodexConfig(managed: boolean): string[] {
  return managed ? ['-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="keyring"'] : [];
}
export function helmArgs(id: HelmAgentId, prompt: string, model?: string, managedCodex=false, workspace?: string): string[] {
  const m = model ? ['--model', model] : [];
  switch (id) {
    case 'codex': return ['exec', '--sandbox', 'workspace-write', '--json', ...helmCodexConfig(managedCodex), ...m, '--', prompt];
    case 'claude': return ['--print', '--output-format', 'json', '--permission-mode', 'acceptEdits', ...m, '--', prompt];
    case 'gemini': return ['--prompt', prompt, '--output-format', 'json', '--approval-mode', 'auto_edit', ...m];
    case 'opencode': return ['run', '--format', 'json', ...(workspace ? ['--dir',workspace] : []), ...m, '--', prompt];
    case 'grok': return ['--sandbox', 'workspace', '--single', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', ...m];
    default: throw new Error('Hades uses the built-in executor');
  }
}
/** Structured failures remain failures even when a provider exits zero. */
export function helmProviderError(text: string): string | undefined {
  for (const line of [text, ...text.split('\n')]) {
    try {
      const e = JSON.parse(line);
      if (e?.is_error === true || e?.type === 'error' || e?.type === 'turn.failed' || e?.error) {
        const message=[e.error?.data?.message,e.error?.message,e.error,e.message,e.result].find(v=>typeof v==='string');
        return (message ?? 'Provider reported failure').slice(0,2000);
      }
    } catch { /* ordinary text output */ }
  }
  return undefined;
}

export function helmAgentEnv(id: HelmAgentId, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if(id==='codex' && env.HADES_CODEX_HOME){const safe={...env};delete safe.OPENAI_API_KEY;delete safe.CODEX_API_KEY;delete safe.CODEX_ACCESS_TOKEN;return safe;}
  if (id !== 'opencode') return env;
  const local={...env};for(const key of Object.keys(local)){if(/^OPENCODE_(SERVER_|ATTACH|SESSION|CWD|DIRECTORY|WORKSPACE)/.test(key))delete local[key];}
  return {...local, OPENCODE_PERMISSION: JSON.stringify({'*':'ask',read:{'*':'allow','*.env':'deny','*.env.*':'deny','*.env.example':'allow'},edit:'allow',glob:'allow',grep:'allow',external_directory:'deny'}), OPENCODE_DISABLE_AUTOUPDATE:'true', OPENCODE_DISABLE_LSP_DOWNLOAD:'true', OPENCODE_AUTO_SHARE:'false'};
}
