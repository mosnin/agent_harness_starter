import { spawn } from 'node:child_process';
import { helmAgentEnv, helmBinary, helmCodexConfig, helmEnv } from './helm-adapters.js';
import type { HelmAgentId } from './helm-types.js';

export interface HelmProviderReadiness {
  installed: boolean;
  version?: string;
  auth: 'unknown' | 'signed-in' | 'signed-out';
  probe: 'available' | 'missing' | 'failed' | 'timed-out';
  model: 'unverified';
  checkedAt: number;
  nextStep: string;
}
export interface HelmProbeResult { code: number | null; output: string; timedOut?: boolean }
export type HelmProbeRunner = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<HelmProbeResult>;

/** No shell, inherited stdin, prompts, raw diagnostic forwarding or account changes. */
export const runHelmProbe: HelmProbeRunner = (command, args, cwd, env, timeoutMs) => new Promise(resolve => {
  let output = '', done = false;
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const finish = (result: HelmProbeResult) => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
  const timer = setTimeout(() => {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    finish({ code: null, output: '', timedOut: true });
  }, timeoutMs);
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(0, 16384); };
  child.stdout?.on('data', collect); child.stderr?.on('data', collect);
  child.on('error', () => finish({ code: null, output: '' }));
  child.on('close', code => finish({ code, output }));
});

/** Explicit refresh only. Login status is local evidence, never a paid model probe. */
export async function probeHelmAgent(id: HelmAgentId, env: NodeJS.ProcessEnv, options: {
  cwd: string;
  builtinAvailable?: boolean;
  run?: HelmProbeRunner;
}): Promise<HelmProviderReadiness> {
  const base = { auth: 'unknown' as const, model: 'unverified' as const, checkedAt: Date.now() };
  if (id === 'hades') return { ...base, installed: !!options.builtinAvailable, probe: options.builtinAvailable ? 'available' : 'missing', nextStep: options.builtinAvailable ? 'Choose a configured Hades profile and complete a small task to verify its model.' : 'The built-in Hades executor is unavailable.' };
  const binary = helmBinary(id, env);
  if (!binary) return { ...base, installed: false, probe: 'missing', nextStep: `Install ${id === 'grok' ? 'Grok Build' : id === 'gemini' ? 'Gemini CLI' : id}, then refresh agents.` };
  const run = options.run ?? runHelmProbe;
  const localEnv = helmAgentEnv(id, helmEnv(env));
  const check = async (args: string[]) => { try { return await run(binary, args, options.cwd, localEnv, 5000); } catch { return { code: null, output: '' }; } };
  const versionResult = await check(['--version']);
  // Accept only a version token; CLI diagnostics can contain user paths or secrets.
  const version = versionResult.code === 0 ? versionResult.output.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/)?.[0] : undefined;
  const present = { ...base, installed: true, ...(version ? { version } : {}) };
  if (versionResult.timedOut) return { ...present, probe: 'timed-out', nextStep: 'The CLI version check timed out. Check that the application can launch this CLI, then refresh.' };
  if (versionResult.code !== 0) return { ...present, probe: 'failed', nextStep: 'The installed CLI could not start. Repair its installation, then refresh.' };
  const args = id === 'codex' ? ['login', 'status', ...helmCodexConfig(!!env.HADES_CODEX_HOME)] : id === 'claude' ? ['auth', 'status', '--json'] : undefined;
  if (!args) return { ...present, probe: 'available', nextStep: 'CLI starts. Account and model access are unverified; complete a small task with your chosen model.' };
  const result = await check(args);
  if (result.timedOut) return { ...present, probe: 'timed-out', nextStep: id === 'codex' && env.HADES_CODEX_HOME ? 'Codex account status timed out. Open Hades Settings and check its ChatGPT connection and any macOS Keychain prompt, then refresh. No task was sent.' : 'Account status timed out. Check the provider login and any operating-system prompt, then refresh. No task was sent.' };
  let auth: HelmProviderReadiness['auth'] = 'unknown';
  if (id === 'codex') {
    if (result.code === 0 && /^Logged in using (ChatGPT|an API key)/m.test(result.output)) auth = 'signed-in';
    else if (/^Not logged in\s*$/m.test(result.output)) auth = 'signed-out';
  } else {
    try { const parsed = JSON.parse(result.output); if (parsed.loggedIn === true && result.code === 0) auth = 'signed-in'; else if (parsed.loggedIn === false) auth = 'signed-out'; } catch { /* Unknown CLI format is not authentication evidence. */ }
  }
  return { ...present, auth, probe: auth === 'unknown' && result.code !== 0 ? 'failed' : 'available', nextStep: auth === 'signed-in' ? 'Local login is present. Model access and task execution still need a successful task.' : auth === 'signed-out' ? (id === 'codex' && env.HADES_CODEX_HOME ? 'Sign in with ChatGPT in Hades Settings, then refresh agents.' : `Sign in using ${id === 'claude' ? 'claude auth login' : 'codex login'}, then refresh agents.`) : 'Login status could not be verified. Check the provider account, then complete a small task with your chosen model.' };
}
