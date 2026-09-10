import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join,relative } from 'node:path';
export const rebuildAction='Commit the intended Helm fork changes, update third_party/helm-opencode.json to that reviewed revision, then run HADES_HELM_REQUIRE_PIN=1 npm run helm:build -- --source /path/to/helm-opencode using Bun 1.3.14. Set HADES_HELM_OPENCODE_SOURCE to that checkout when packaging.';
const fail=message=>{throw new Error(message+' '+rebuildAction);};
export const sha256=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export function uiFiles(directory){const result=[];function walk(prefix=''){for(const entry of readdirSync(join(directory,prefix),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const rel=prefix+entry.name;if(rel==='helm-provenance.json')continue;const p=join(directory,rel);if(entry.isSymbolicLink())fail('Symlink in Helm assets.');if(entry.isDirectory())walk(rel+'/');else if(entry.isFile())result.push({path:rel,sha256:sha256(p)});else fail('Unsupported Helm asset.');}}walk();return result;}
export function sourceState(directory){const source=realpathSync(directory);const git=args=>execFileSync('git',['-c','core.fsmonitor=false','-C',source,...args],{encoding:'utf8',maxBuffer:16*1024*1024}).trim();const revision=git(['rev-parse','HEAD']),dirty=!!git(['status','--porcelain','--untracked-files=all']);const files=execFileSync('git',['-c','core.fsmonitor=false','-C',source,'ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8',maxBuffer:16*1024*1024}).split('\0').filter(Boolean).sort();const hash=createHash('sha256');for(const file of [...new Set(files)]){hash.update(file+'\0');let stat;try{stat=lstatSync(join(source,file));}catch(e){if(e.code==='ENOENT'){hash.update('missing\0');continue;}throw e;}if(stat.isSymbolicLink()){const actual=realpathSync(join(source,file));if(!actual.startsWith(source+'/'))fail('Source symlink escapes the checkout: '+file);const target=lstatSync(actual);hash.update('link:'+readlinkSync(join(source,file))+'\0');if(target.isFile())hash.update(sha256(actual)+'\0');else if(!target.isDirectory()||!files.some(p=>p.startsWith(relative(source,actual)+'/')))fail('Source directory link has no inventoried contents: '+file);}else{if(!stat.isFile())fail('Unsupported source entry: '+file);hash.update(sha256(join(source,file))+'\0');}}return {revision,dirty,sourceSha256:hash.digest('hex')};}
export function verifyHelm({assets,runtime,pin,source,checkRuntime=true}){
 const provenance=JSON.parse(readFileSync(join(assets,'helm-provenance.json'),'utf8'));
 if(provenance.schema!==2||!Array.isArray(provenance.uiFiles)||!provenance.uiFiles.some(f=>f.path==='index.html')||!/^([a-f0-9]{64})$/.test(provenance.sourceSha256??''))fail('Helm assets have no complete source/UI provenance.');
 if(provenance.dirty!==false||provenance.revision!==pin.revision||provenance.version!==pin.version||provenance.bun!==pin.bun)fail('Helm assets do not match the clean reviewed fork/toolchain pin.');
 if(source){const current=sourceState(source);if(current.dirty||current.revision!==provenance.revision||current.sourceSha256!==provenance.sourceSha256)fail('Helm fork source differs from the compiled assets.');}
 if(JSON.stringify(uiFiles(assets))!==JSON.stringify(provenance.uiFiles))fail('Helm UI asset inventory or bytes changed after build.');
 if(checkRuntime&&sha256(runtime)!==provenance.runtimeSha256)fail('Helm runtime bytes differ from build provenance.');
 return provenance;
}
/** Compare signed Mach-O payloads while excluding only signature bytes and LINKEDIT size bookkeeping. */
export function runtimePayloadSha256(path){
 const data=readFileSync(path);if(data.length<32||data.readUInt32LE(0)!==0xfeedfacf)return createHash('sha256').update(data).digest('hex');
 const count=data.readUInt32LE(16),commandBytes=data.readUInt32LE(20);if(count>4096||commandBytes>1024*1024||32+commandBytes>data.length)fail('Malformed runtime Mach-O header.');
 let offset=32,signature;const normalized=Buffer.from(data);
 for(let i=0;i<count;i++){if(offset+8>32+commandBytes)fail('Malformed runtime load commands.');const command=data.readUInt32LE(offset),size=data.readUInt32LE(offset+4);if(size<8||offset+size>32+commandBytes)fail('Malformed runtime load command size.');if(command===0x1d){if(size!==16||signature)fail('Unsupported runtime signature command.');signature={offset:data.readUInt32LE(offset+8),size:data.readUInt32LE(offset+12)};normalized.fill(0,offset+8,offset+16);}if(command===0x19&&size>=72&&data.subarray(offset+8,offset+24).toString().replace(/\0.*$/,'')==='__LINKEDIT'){normalized.fill(0,offset+32,offset+40);normalized.fill(0,offset+48,offset+56);}offset+=size;}
 if(!signature||signature.offset<32+commandBytes||signature.offset+signature.size!==data.length)fail('Runtime signature layout cannot be compared safely.');
 return createHash('sha256').update(normalized.subarray(0,signature.offset)).digest('hex');
}
