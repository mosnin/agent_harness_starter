import { describe, expect, it } from 'vitest';
import { probeHelmAgent, runHelmProbe, type HelmProbeRunner } from '../core/helm-provider-readiness.js';
import { helmArgs, helmBinary, helmCodexConfig } from '../core/helm-adapters.js';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: '', HADES_HELM_CODEX_BIN: process.execPath, HADES_HELM_CLAUDE_BIN: process.execPath, HADES_HELM_OPENCODE_BIN: process.execPath, HADES_CODEX_HOME: '/managed', OPENAI_API_KEY: 'secret-test' };
const probe = (output: string, code: number | null = 0, timedOut = false) => {
 const calls: Array<{args: string[]; env: NodeJS.ProcessEnv}> = [];
 const run: HelmProbeRunner = async (_binary, args, _cwd, e) => { calls.push({args,env:e}); return args[0] === '--version' ? {code:0, output:'codex-cli 1.2.3'} : {code, output, timedOut}; };
 return {calls,run};
};
describe('Helm provider readiness', () => {
 it('uses the exact managed Codex auth store but never exposes account diagnostics', async () => {
  const {calls,run}=probe('Logged in using ChatGPT\nprivate account@example.com secret');
  const result=await probeHelmAgent('codex',env,{cwd:'/tmp',run});
  expect(result).toMatchObject({installed:true,auth:'signed-in',model:'unverified',probe:'available',version:'1.2.3'});
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(calls[1].args).toEqual(['login','status',...helmCodexConfig(true)]);
  expect(calls[1].env.CODEX_HOME).toBe('/managed'); expect(calls[1].env.OPENAI_API_KEY).toBeUndefined();
  expect(helmArgs('codex','task',undefined,true)).toEqual(expect.arrayContaining(helmCodexConfig(true)));
 });
 it('keeps standalone credentials/configuration unchanged', async()=>{
  const {calls,run}=probe('Logged in using an API key - secret');
  await probeHelmAgent('codex',{NODE_ENV:'test',HADES_HELM_CODEX_BIN:process.execPath,OPENAI_API_KEY:'test'},{cwd:'/tmp',run});
  expect(calls[1].args).toEqual(['login','status']); expect(calls[1].env.OPENAI_API_KEY).toBe('test');
 });
 it('distinguishes missing auth from a keychain timeout',async()=>{
  expect(await probeHelmAgent('codex',env,{cwd:'/tmp',run:probe('Not logged in',1).run})).toMatchObject({auth:'signed-out',probe:'available',nextStep:expect.stringContaining('Hades Settings')});
  expect(await probeHelmAgent('codex',env,{cwd:'/tmp',run:probe('',null,true).run})).toMatchObject({auth:'unknown',probe:'timed-out',nextStep:expect.stringContaining('Keychain')});
 });
 it('does not treat an unexpected successful status or expired credential error as ready',async()=>{
  const result=await probeHelmAgent('codex',env,{cwd:'/tmp',run:probe('unexpected success').run});
  expect(result.auth).toBe('unknown'); expect(result.model).toBe('unverified');
  const failed=await probeHelmAgent('claude',env,{cwd:'/tmp',run:probe('{"error":"token expired","email":"secret"}',1).run});
  expect(failed).toMatchObject({auth:'unknown',probe:'failed'}); expect(JSON.stringify(failed)).not.toContain('secret');
 });
 it('reads only a boolean from Claude JSON',async()=>{
  for(const loggedIn of [true,false]) {
   const result=await probeHelmAgent('claude',env,{cwd:'/tmp',run:probe(JSON.stringify({loggedIn,email:'secret'}),loggedIn?0:1).run});
   expect(result.auth).toBe(loggedIn?'signed-in':'signed-out'); expect(JSON.stringify(result)).not.toContain('secret');
  }
 });
 it('does not infer OpenCode account or model access from installation',async()=>{
  const {calls,run}=probe(''); const result=await probeHelmAgent('opencode',env,{cwd:'/tmp',run});
  expect(result).toMatchObject({auth:'unknown',model:'unverified',probe:'available'}); expect(calls).toHaveLength(1);
 });
 it('does not mistake an executable directory for a CLI',()=>{ expect(helmBinary('codex',{NODE_ENV:'test',HADES_HELM_CODEX_BIN:'/tmp'})).toBeUndefined(); });
 it('missing executables never invoke a process',async()=>{
  let called=false; const result=await probeHelmAgent('gemini',{NODE_ENV:'test',HADES_HELM_GEMINI_BIN:'/not-present-helm-test'},{cwd:'/tmp',run:async()=>{called=true;throw Error();}});
  expect(result).toMatchObject({installed:false,probe:'missing'});expect(called).toBe(false);
 });
 it('failed and hanging version checks stop before auth',async()=>{
  for(const value of [{code:1,output:'secret'},{code:null,output:'secret',timedOut:true}]) {
   let count=0;const result=await probeHelmAgent('codex',env,{cwd:'/tmp',run:async()=>{count++;return value;}});
   expect(count).toBe(1);expect(result.auth).toBe('unknown');expect(result.probe).toBe(value.timedOut?'timed-out':'failed');expect(JSON.stringify(result)).not.toContain('secret');
  }
 });
 it('reports builtin presence without claiming profile authentication',async()=>{
  expect(await probeHelmAgent('hades',env,{cwd:'/tmp',builtinAvailable:true})).toMatchObject({installed:true,auth:'unknown',model:'unverified'});
 });
 it('bounds a real hung process without a model call',async()=>{
  const start=Date.now();const result=await runHelmProbe(process.execPath,['-e','setInterval(()=>{},1000)'],'/tmp',process.env,60);
  expect(result.timedOut).toBe(true);expect(Date.now()-start).toBeLessThan(2000);
 });
 it('returns safe failure for spawn errors',async()=>{
  expect(await runHelmProbe('/not-present-helm-test',[],'/tmp',process.env,60)).toEqual({code:null,output:''});
 });
});
