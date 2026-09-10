#!/usr/bin/env node
// Explicit local source only. Never installs, downloads, resets or modifies the upstream checkout.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
const source=process.env.HELM_ORCA_SOURCE;
if(!source)throw new Error('Set HELM_ORCA_SOURCE to the pinned local Orca checkout');
const root=resolve(source),pin='bf4e2705046cf9ef9c915929a9646da85717af07';
const git=(args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
if(git(['rev-parse','HEAD'])!==pin||git(['status','--porcelain','--untracked-files=no']))throw new Error('Orca source must match the clean pinned revision');
for(const path of ['node_modules/esbuild/package.json','node_modules/node-pty/package.json','node_modules/@parcel/watcher/package.json'])if(!existsSync(join(root,path)))throw new Error('Missing upstream locked build/native dependency: '+path+'; no automatic install attempted');
if(process.argv.includes('--check')){console.log(JSON.stringify({sourceRevision:pin,dependenciesPresent:true,buildRun:false}));process.exit(0);}
if(!process.argv.includes('--build'))throw new Error('Use --check or explicitly --build; build requires adequate disk');
execFileSync(process.execPath,['config/scripts/build-orcad.mjs'],{cwd:root,stdio:'inherit'});
const out=resolve(process.env.HELM_ORCA_OUTPUT??'dist/helm-orca');if(existsSync(out))throw new Error('Choose a new empty HELM_ORCA_OUTPUT; existing artifacts are never overwritten');
mkdirSync(out,{recursive:true});cpSync(join(root,'out/orcad'),out,{recursive:true});
// Stage only the resolved runtime native dependency closure, including installed optional platform packages.
const staged=new Map();
function stagePackage(name,from,optional=false){
 const req=createRequire(join(from,'package.json'));let manifest;
 try{manifest=req.resolve(name+'/package.json');}catch{
  try{let cursor=dirname(req.resolve(name));while(!existsSync(join(cursor,'package.json'))&&dirname(cursor)!==cursor)cursor=dirname(cursor);manifest=join(cursor,'package.json');}catch(e){if(optional)return;throw new Error('Missing locked runtime dependency '+name,{cause:e});}
 }
 const pkg=JSON.parse(readFileSync(manifest,'utf8'));
 if(staged.has(name)){if(staged.get(name)!==pkg.version)throw new Error('Conflicting native dependency versions: '+name);return;}
 staged.set(name,pkg.version);const packageRoot=dirname(manifest),target=join(out,'node_modules',name);mkdirSync(dirname(target),{recursive:true});cpSync(packageRoot,target,{recursive:true,dereference:true});
 for(const dep of Object.keys(pkg.dependencies??{}))stagePackage(dep,packageRoot);
 for(const dep of Object.keys(pkg.optionalDependencies??{}))stagePackage(dep,packageRoot,true);
}
stagePackage('node-pty',root);stagePackage('@parcel/watcher',root);
const files=[];function walk(dir,prefix=''){for(const ent of readdirSync(dir,{withFileTypes:true})){const p=join(dir,ent.name),rel=prefix+ent.name;if(ent.isSymbolicLink())throw new Error('Unresolved artifact symlink: '+rel);if(ent.isDirectory())walk(p,rel+'/');else files.push({path:rel,sha256:createHash('sha256').update(readFileSync(p)).digest('hex'),bytes:statSync(p).size});}}walk(out);
cpSync(join(root,'LICENSE'),join(out,'LICENSE'));files.push({path:'LICENSE',sha256:createHash('sha256').update(readFileSync(join(out,'LICENSE'))).digest('hex')});
writeFileSync(join(out,'helm-orca-build.json'),JSON.stringify({sourceRevision:pin,node:process.version,platform:process.platform,arch:process.arch,files},null,2));
console.log(JSON.stringify({sourceRevision:pin,output:out,files:files.length}));
