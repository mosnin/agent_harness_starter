#!/usr/bin/env node
// Data-only vendoring. Never invokes npm/Bun install hooks or framework scripts.
import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=realpathSync(process.argv[2]||'/Users/preston/companyos-release');
const output=resolve(process.argv[3]||'third_party/company-os');
const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
if(git('status','--porcelain'))throw Error('Canonical Company OS checkout must be clean');
const revision=git('rev-parse','HEAD'),pkg=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
const distribution=JSON.parse(readFileSync(join(source,'distribution-manifest.json'),'utf8'));
if(pkg.name!=='@mosnin/companyos'||pkg.version!==distribution.distribution_version||readFileSync(join(source,'VERSION'),'utf8').trim()!==pkg.version)throw Error('Company OS release identity mismatch');
const hash=b=>createHash('sha256').update(b).digest('hex');
const seen=new Set();
const files=distribution.files.map(entry=>{
 if(!/^(company-os|autonomy-suite)\/[A-Za-z0-9_./-]+$/.test(entry.path)||entry.path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(entry.path))throw Error('Unsafe distribution path');seen.add(entry.path);
 const file=join(source,'skills',entry.path),real=realpathSync(file),bytes=readFileSync(file);
 if(lstatSync(file).isSymbolicLink()||!real.startsWith(join(source,'skills')+sep)||bytes.length!==entry.size||hash(bytes)!==entry.sha256)throw Error('Distribution integrity failed: '+entry.path);
 const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))throw Error('Non-text source requires explicit packaging support');
 return {path:entry.path,sha256:entry.sha256,bytes:entry.size,text};
});
if(git('status','--porcelain')||git('rev-parse','HEAD')!==revision)throw Error('Source changed during packaging');
const bundle={schema:1,package:'@mosnin/companyos',version:pkg.version,revision,repository:'https://github.com/mosnin/companyos',license:pkg.license,distributionSha256:hash(readFileSync(join(source,'distribution-manifest.json'))),files};
const bytes=Buffer.from(JSON.stringify(bundle));if(bytes.length>20*1024*1024)throw Error('Bundle exceeds bounds');mkdirSync(output,{recursive:true});writeFileSync(join(output,'bundle.json'),bytes);
writeFileSync(join(output,'manifest.json'),JSON.stringify({schema:1,package:bundle.package,version:bundle.version,revision,sha256:hash(bytes),bytes:bytes.length,files:files.length,license:pkg.license,repository:bundle.repository,npm:{name:pkg.name,engines:pkg.engines},compatibility:'Data-only JSON; vendor script uses Node builtins available in Node20+ and Bun. Bun execution not verified.'},null,2)+'\n');
console.log(JSON.stringify({version:pkg.version,revision,files:files.length,bytes:bytes.length,sha256:hash(bytes)}));
