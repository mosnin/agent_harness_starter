import {createHash,randomBytes} from 'node:crypto';
import {lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
export const HELM_STORAGE_LIMITS={valueBytes:8*1024*1024,requestBytes:12*1024*1024,totalBytes:64*1024*1024,entries:4096};
/** Synchronous transactions serialize admission and atomic replacement within the
 * owning sidecar. Keys are opaque; no caller path is ever used as a disk path. */
export class HelmCodeStorage {
 constructor(private directory:string,private limits=HELM_STORAGE_LIMITS){
  const stat=lstatSync(directory,{throwIfNoEntry:false});
  if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw new Error('Invalid private storage directory');
  mkdirSync(directory,{recursive:true,mode:0o700});
  // A crash before rename can leave only our private temporary files.
  for(const name of readdirSync(directory))if(/^[a-f0-9]{64}\.json\.[a-f0-9]{16}\.tmp$/.test(name)){const file=join(directory,name),stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Invalid private storage contents');unlinkSync(file);}

  this.collectOrphanedBlobs();
 }
 /** Startup only, before this sidecar admits UI writes. Validate everything
  * first; any malformed document suppresses collection without deleting data. */
 private collectOrphanedBlobs():void {
  const candidates:Array<{file:string;key:string}>=[],used=new Set<string>();
  try{
   const names=readdirSync(this.directory);if(names.length>this.limits.entries)return;
   let bytes=0;const files=names.map(name=>{if(!/^[a-f0-9]{64}\.json$/.test(name))throw new Error();const file=join(this.directory,name),stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>this.limits.requestBytes)throw new Error();bytes+=stat.size;return {file,name};});
   if(bytes>this.limits.totalBytes)return;
   for(const {file,name} of files){
    const r=JSON.parse(readFileSync(file,'utf8'));
    if(!r||typeof r.bucket!=='string'||!['ui','draft','blob'].includes(r.bucket)||typeof r.key!=='string'||!r.key.length||r.key.length>512||r.key.includes('\0')||typeof r.value!=='string'||Buffer.byteLength(r.value)>this.limits.valueBytes||createHash('sha256').update(r.bucket+'\0'+r.key).digest('hex')+'.json'!==name)throw new Error();
    if(r.bucket==='draft')JSON.parse(r.value,(_key,value)=>{if(value?.blob!==undefined){if(!value.blob||typeof value.blob.id!=='string')throw new Error();used.add(value.blob.id);}return value;});
    if(r.bucket==='blob'){const blob=JSON.parse(r.value);if(!blob||typeof blob.mime!=='string'||typeof blob.data!=='string')throw new Error();candidates.push({file,key:r.key});}
   }
  }catch{return;}
  for(const candidate of candidates)if(!used.has(candidate.key))unlinkSync(candidate.file);
 }
 execute(input:unknown):{value:string|null}|{ok:true}{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid storage request');
  const a=input as Record<string,unknown>;
  if(Object.keys(a).some(k=>!['action','bucket','key','value'].includes(k))||typeof a.action!=='string'||!['get','set','remove'].includes(a.action)||typeof a.bucket!=='string'||!['ui','draft','blob'].includes(a.bucket)||typeof a.key!=='string'||!a.key.length||a.key.length>512||a.key.includes('\0'))throw new Error('Invalid storage request');
  if(a.action==='set'&&(typeof a.value!=='string'||Buffer.byteLength(a.value)>this.limits.valueBytes))throw new Error('Storage value exceeds limit');
  const dir=lstatSync(this.directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw new Error('Invalid private storage directory');
  const name=createHash('sha256').update(a.bucket+'\0'+a.key).digest('hex')+'.json',file=join(this.directory,name);
  const stat=lstatSync(file,{throwIfNoEntry:false});
  if(stat&&(!stat.isFile()||stat.isSymbolicLink()||stat.size>this.limits.requestBytes))throw new Error('Invalid private storage entry');
  if(a.action==='get'){
   if(!stat)return {value:null};const record=JSON.parse(readFileSync(file,'utf8'));
   if(record.bucket!==a.bucket||record.key!==a.key||typeof record.value!=='string'||Buffer.byteLength(record.value)>this.limits.valueBytes)throw new Error('Invalid private storage entry');
   return {value:record.value};
  }
  if(a.action==='remove'){if(stat)unlinkSync(file);return {ok:true};}
  const encoded=JSON.stringify({bucket:a.bucket,key:a.key,value:a.value});if(Buffer.byteLength(encoded)>this.limits.requestBytes)throw new Error('Storage encoded value exceeds limit');let count=0,bytes=0;
  for(const item of readdirSync(this.directory)){
   if(!/^[a-f0-9]{64}\.json$/.test(item))throw new Error('Invalid private storage contents');
   const s=lstatSync(join(this.directory,item));if(!s.isFile()||s.isSymbolicLink())throw new Error('Invalid private storage entry');count++;bytes+=s.size;
  }
  if(count+(stat?0:1)>this.limits.entries||bytes-(stat?.size??0)+Buffer.byteLength(encoded)>this.limits.totalBytes)throw new Error('Private storage quota exceeded');
  const temporary=join(this.directory,name+'.'+randomBytes(8).toString('hex')+'.tmp');
  try{writeFileSync(temporary,encoded,{mode:0o600,flag:'wx',flush:true});renameSync(temporary,file);}finally{try{unlinkSync(temporary);}catch{}}
  return {ok:true};
 }
}
