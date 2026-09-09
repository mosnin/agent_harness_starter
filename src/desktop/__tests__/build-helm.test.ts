import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync,execFileSync} from 'node:child_process';
let directory:string,source:string,bun:string,marker:string;
const script=resolve('scripts/build-helm.mjs');
beforeEach(()=>{
 directory=mkdtempSync(join(tmpdir(),'helm-packaging-gate-'));source=join(directory,'fork');marker=join(directory,'build-invoked');bun=join(directory,'fake-bun');
 mkdirSync(join(source,'packages/app/src'),{recursive:true});mkdirSync(join(source,'packages/opencode/src/server/shared'),{recursive:true});
 writeFileSync(join(source,'packages/app/src/helm-host.ts'),'// owned host entry');writeFileSync(join(source,'packages/opencode/package.json'),JSON.stringify({version:'1.18.21'}));
 writeFileSync(bun,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'fixture only');process.exit(9);\n`,{mode:0o700});
});
afterEach(()=>rmSync(directory,{recursive:true,force:true}));
function invoke(args:string[]){return spawnSync(process.execPath,[script,...args],{cwd:directory,env:{...process.env,HADES_BUN:bun},encoding:'utf8',timeout:5000});}
it('rejects an older host fork without the local UI guard before any build runs',()=>{
 writeFileSync(join(source,'packages/opencode/src/server/shared/ui.ts'),'export const hostedFallback = true;');
 const result=invoke(['--source',source]);expect(result.status).not.toBe(0);expect(result.stderr).toContain('missing the managed local UI guard');expect(result.stderr).toContain('OPENCODE_HELM_LOCAL_UI');expect(existsSync(marker)).toBe(false);
});
it('rejects a missing guard source file visibly before any build runs',()=>{const result=invoke(['--source',source]);expect(result.stderr).toContain('Update the Helm integration fork');expect(existsSync(marker)).toBe(false);});
it('rejects --source without a path instead of selecting the current directory',()=>{for(const args of [['--source'],['--source','--help'],['--source','   ']]){const result=invoke(args);expect(result.status).not.toBe(0);expect(result.stderr).toContain('--source requires a path');}expect(existsSync(marker)).toBe(false);});
it('accepts a guard-capable fork without hardlocking its commit and only invokes the fixture builder',()=>{
 writeFileSync(join(source,'packages/opencode/src/server/shared/ui.ts'),'if (process.env.OPENCODE_HELM_LOCAL_UI === "1") return Effect.succeed(notFound());');
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Independent fixture revision']])execFileSync('git',args,{cwd:source});
 const result=invoke(['--source',source]);expect(result.status).not.toBe(0);expect(existsSync(marker)).toBe(true);expect(result.stderr).toContain('failed (9)');expect(result.stderr).not.toContain('missing the managed local UI guard');
});
