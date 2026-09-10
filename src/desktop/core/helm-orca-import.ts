import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
const exec = promisify(execFile);
export interface HelmOrcaImportDescriptor {
  intentId:string; runtimeId:string; runId:string; dispatchId:string; worktreeId:string;
  root:string; profile:string; baseSha:string; workspace:string;
  workspaceIdentity:{dev:number;ino:number;gitFileDigest:string}; sourceIdentity:{dev:number;ino:number;commonDir:string;commonDev:number;commonIno:number}; revision:string;
}
export async function orcaImportGit(root:string,args:string[],signal?:AbortSignal,index?:string):Promise<string> {
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
  env.GIT_CONFIG_GLOBAL='/dev/null';env.GIT_CONFIG_NOSYSTEM='1';env.GIT_OPTIONAL_LOCKS='0';if(index)env.GIT_INDEX_FILE=index;
  return (await exec('git',['--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{cwd:root,env,signal,timeout:30000,maxBuffer:8_000_000,encoding:'utf8'})).stdout;
}
export async function resolveOrcaSourceBase(root:string,signal?:AbortSignal):Promise<string> {
  if(realpathSync(root)!==root||realpathSync((await orcaImportGit(root,['rev-parse','--show-toplevel'],signal)).trim())!==root)throw new Error('Source repository identity changed');
  const base=(await orcaImportGit(root,['rev-parse','--verify','HEAD^{commit}'],signal)).trim();
  if(!/^[a-f0-9]{40}$/.test(base))throw new Error('Unsupported source commit identity');return base;
}
export async function orcaSourceIdentity(root:string,signal?:AbortSignal){
  if(realpathSync(root)!==root)throw new Error('Source identity redirected');
  const stat=lstatSync(root),commonDir=realpathSync((await orcaImportGit(root,['rev-parse','--path-format=absolute','--git-common-dir'],signal)).trim()),common=lstatSync(commonDir);
  return {dev:stat.dev,ino:stat.ino,commonDir,commonDev:common.dev,commonIno:common.ino};
}
/** Bounded read-only snapshot; no checkout, temporary index, filters or hooks. */
export async function snapshotOrcaWorkspace(root:string,workspace:string,baseSha:string,signal?:AbortSignal) {
  if(!/^[a-f0-9]{40}$/.test(baseSha)||workspace===root||realpathSync(workspace)!==workspace)throw new Error('Invalid isolated workspace');
  const stat=lstatSync(workspace),gitFile=join(workspace,'.git');
  if(!stat.isDirectory()||!lstatSync(gitFile).isFile()||lstatSync(gitFile).isSymbolicLink())throw new Error('Workspace identity changed');
  const common=async(path:string)=>realpathSync((await orcaImportGit(path,['rev-parse','--path-format=absolute','--git-common-dir'],signal)).trim());
  const commonDir=await common(root),sourceStat=lstatSync(root),commonStat=lstatSync(commonDir);
  const sourceIdentity={dev:sourceStat.dev,ino:sourceStat.ino,commonDir,commonDev:commonStat.dev,commonIno:commonStat.ino};
  if(realpathSync(root)!==root||commonDir!==await common(workspace))throw new Error('Workspace belongs to another repository');
  if(realpathSync((await orcaImportGit(workspace,['rev-parse','--show-toplevel'],signal)).trim())!==workspace)throw new Error('Workspace root changed');
  await orcaImportGit(workspace,['merge-base','--is-ancestor',baseSha,'HEAD'],signal);
  const config=await orcaImportGit(workspace,['config','--null','--list'],signal);
  if(config.split('\0').some(x=>/^filter\..*\.(clean|smudge|process)\n[\s\S]+$/.test(x)))throw new Error('Git filters are unsupported for Orca import');
  const flags=(await orcaImportGit(workspace,['ls-files','-v','-z'],signal)).split('\0').filter(Boolean);
  if(flags.some(x=>x[0]==='S'||x[0]===x[0].toLowerCase()))throw new Error('Hidden index flags are unsupported');
  if((await orcaImportGit(workspace,['ls-files','--stage','-z'],signal)).split('\0').some(x=>x.startsWith('160000 ')))throw new Error('Submodules are unsupported');
  const identity={dev:stat.dev,ino:stat.ino,gitFileDigest:createHash('sha256').update(readFileSync(gitFile)).digest('hex')};
  const hash=createHash('sha256').update(JSON.stringify(identity)).update(baseSha);
  hash.update(await orcaImportGit(workspace,['rev-parse','HEAD'],signal));
  hash.update(await orcaImportGit(workspace,['diff','--no-ext-diff','--no-textconv','--binary',baseSha,'--'],signal));
  const files=(await orcaImportGit(workspace,['ls-files','--cached','--others','--exclude-standard','-z'],signal)).split('\0').filter(Boolean).sort();
  let bytes=0;
  for(const file of new Set(files)){
    signal?.throwIfAborted();const parts=file.split('/');if(parts.some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid workspace path');
    for(let i=1;i<parts.length;i++){try{if(lstatSync(join(workspace,...parts.slice(0,i))).isSymbolicLink())throw new Error('Workspace path escapes through symlink');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')break;throw e;}}
    const path=join(workspace,file);let st;try{st=lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'){hash.update('\0deleted:'+file);continue;}throw e;}
    if(!st.isFile()&&!st.isSymbolicLink())throw new Error('Nested repositories or special files unsupported');
    bytes+=st.size;if(bytes>32_000_000)throw new Error('Workspace snapshot exceeds 32 MB');
    hash.update('\0'+file+'\0'+st.mode+'\0').update(st.isSymbolicLink()?readlinkSync(path):readFileSync(path));
  }
  return {sourceIdentity,workspaceIdentity:identity,revision:hash.digest('hex')};
}

export async function assertOrcaImportDescriptor(d:HelmOrcaImportDescriptor,signal?:AbortSignal){
  const snapshot=await snapshotOrcaWorkspace(d.root,d.workspace,d.baseSha,signal);
  if(snapshot.revision!==d.revision||JSON.stringify(snapshot.workspaceIdentity)!==JSON.stringify(d.workspaceIdentity)||JSON.stringify(snapshot.sourceIdentity)!==JSON.stringify(d.sourceIdentity))throw new Error('Orca import snapshot identity changed');
  return snapshot;
}
/** Caller owns a durable destination claim. Failure leaves destination for explicit inspection. */
export async function materializeOrcaImport(d:HelmOrcaImportDescriptor,destination:string,signal?:AbortSignal){
  if(!isAbsolute(destination)||realpathSync(dirname(destination))!==dirname(destination)||destination===d.root||destination.startsWith(d.root+'/')||destination===d.sourceIdentity.commonDir||destination.startsWith(d.sourceIdentity.commonDir+'/')||destination===d.workspace||destination.startsWith(d.workspace+'/'))throw new Error('Invalid import destination');
  try{lstatSync(destination);throw new Error('Import destination already exists');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  await assertOrcaImportDescriptor(d,signal);
  const temp=mkdtempSync(join(tmpdir(),'helm-orca-import-')),index=join(temp,'index'),patchFile=join(temp,'changes.patch');
  try{
    await orcaImportGit(d.workspace,['read-tree',d.baseSha],signal,index);
    await orcaImportGit(d.workspace,['add','-A','--','.'],signal,index);
    if((await orcaImportGit(d.workspace,['ls-files','--stage','-z'],signal,index)).split('\0').some(x=>x.startsWith('160000 ')))throw new Error('Nested repositories unsupported');
    const patch=await orcaImportGit(d.workspace,['diff','--cached','--binary','--no-ext-diff','--no-textconv',d.baseSha,'--'],signal,index);
    await assertOrcaImportDescriptor(d,signal);signal?.throwIfAborted();
    await orcaImportGit(d.root,['worktree','add','--detach','--',destination,d.baseSha],signal);
    if(patch){writeFileSync(patchFile,patch,{mode:0o600,flag:'wx'});await orcaImportGit(destination,['apply','--whitespace=nowarn','--',patchFile],signal);}
    await assertOrcaImportDescriptor(d,signal);
    return await snapshotOrcaWorkspace(d.root,realpathSync(destination),d.baseSha,signal);
  }finally{rmSync(temp,{recursive:true,force:true});}
}
