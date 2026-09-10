import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const PIN='bf4e2705046cf9ef9c915929a9646da85717af07';
const MANIFEST='helm-orca-build.json';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function validateOrcaPackage(directory) {
 const root=resolve(directory);
 let cursor=root;
 while(true){if(lstatSync(cursor).isSymbolicLink())throw Error('Orca package path cannot contain symlinks');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
 const manifestPath=join(root,MANIFEST),stat=lstatSync(manifestPath);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw Error('Invalid Orca manifest');
 const manifestBytes=readFileSync(manifestPath),manifest=JSON.parse(manifestBytes);
 if(manifest.sourceRevision!==PIN||manifest.platform!==process.platform||manifest.arch!==process.arch||!Array.isArray(manifest.files)||manifest.files.length>4096)throw Error('Orca pin/platform/architecture or manifest mismatch');
 const files=new Map();let total=0;
 for(const f of manifest.files){
  if(!f||typeof f.path!=='string'||f.path.length>2048||f.path.includes('\\')||f.path.split('/').some(p=>!p||p==='.'||p==='..')||files.has(f.path)||f.path===MANIFEST||!/^([a-f0-9]{64})$/.test(f.sha256))throw Error('Invalid Orca inventory path/hash');
  files.set(f.path,f);
 }
 for(const entry of ['orcad.js','daemon-entry.js','parcel-watcher-process-entry.js'])if(!files.has(entry))throw Error('Missing Orca runtime entry '+entry);
 const observed=new Set();
 function walk(dir,prefix=''){
  for(const name of readdirSync(dir)){
   const path=join(dir,name),rel=prefix+name,st=lstatSync(path);
   if(st.isSymbolicLink())throw Error('Orca package symlink: '+rel);
   if(st.isDirectory()){walk(path,rel+'/');continue;}
   if(!st.isFile())throw Error('Unsupported Orca file: '+rel);
   if(rel===MANIFEST)continue;
   const f=files.get(rel);total+=st.size;
   if(!f||st.size>128*1024*1024||total>512*1024*1024||(f.bytes!==undefined&&f.bytes!==st.size)||sha(readFileSync(path))!==f.sha256)throw Error('Orca inventory/hash mismatch: '+rel);
   observed.add(rel);
  }
 }
 walk(root);if(observed.size!==files.size)throw Error('Missing Orca inventory file');
 return {sourceRevision:PIN,manifestSha256:sha(manifestBytes),files:observed.size,bytes:total};
}
export function stageOrcaPackage(source, destination){
 const receipt=validateOrcaPackage(source),src=realpathSync(source),dest=resolve(destination),parent=dirname(dest);
 if(dest===src||dest.startsWith(src+sep)||src.startsWith(dest+sep))throw Error('Orca source and destination must be separate');
 mkdirSync(parent,{recursive:true});
 if(realpathSync(parent)!==parent)throw Error('Orca destination parent must be canonical');
 if(existsSync(dest)&&lstatSync(dest).isSymbolicLink())throw Error('Orca destination cannot be a symlink');
 const temp=join(parent,'.helm-orca-stage-'+randomUUID()),backup=join(parent,'.helm-orca-prior-'+randomUUID());let backed=false,published=false;
 try{
  cpSync(src,temp,{recursive:true,errorOnExist:true,force:false});
  if(validateOrcaPackage(temp).manifestSha256!==receipt.manifestSha256||validateOrcaPackage(src).manifestSha256!==receipt.manifestSha256)throw Error('Orca source changed during staging');
  if(existsSync(dest)){renameSync(dest,backup);backed=true;}
  renameSync(temp,dest);published=true;
  if(backed){try{rmSync(backup,{recursive:true});}catch{/* Published tree is valid; retain the prior backup if cleanup fails. */}}
  return receipt;
 }catch(error){if(backed&&!published)renameSync(backup,dest);throw error;}
 finally{rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [mode,source='dist/helm-orca',destination]=process.argv.slice(2);
  if(mode!=='--check'&&mode!=='--stage'||mode==='--stage'&&!destination)throw Error('Usage: package-helm-orca.mjs --check [source] | --stage source destination');
  console.log(JSON.stringify(mode==='--check'?validateOrcaPackage(source):stageOrcaPackage(source,destination)));
 }catch(error){console.error('Orca packaging refused: '+error.message+'. Build the clean pinned source with HELM_ORCA_SOURCE=/path/to/orca node scripts/build-helm-orca.mjs --build.');process.exitCode=1;}
}
