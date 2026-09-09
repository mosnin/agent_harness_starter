import {afterEach,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,readdirSync,lstatSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HelmCodeStorage} from '../core/helm-code-storage';
const dirs:string[]=[];const fixture=()=>{const p=mkdtempSync(join(tmpdir(),'helm-storage-'));dirs.push(p);return p;};
afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
it('persists opaque keys across instances, isolates buckets and uses private files',()=>{
 const p=fixture();const a=new HelmCodeStorage(p);a.execute({action:'set',bucket:'ui',key:'../../outside',value:'draft'});
 expect(new HelmCodeStorage(p).execute({action:'get',bucket:'ui',key:'../../outside'})).toEqual({value:'draft'});
 expect(a.execute({action:'get',bucket:'blob',key:'../../outside'})).toEqual({value:null});
 expect(lstatSync(join(p,readdirSync(p)[0])).mode&0o777).toBe(0o600);
 a.execute({action:'remove',bucket:'ui',key:'../../outside'});expect(a.execute({action:'get',bucket:'ui',key:'../../outside'})).toEqual({value:null});
});
it('enforces byte/count quotas without destroying existing data',()=>{
 const a=new HelmCodeStorage(fixture(),{valueBytes:10,requestBytes:500,totalBytes:150,entries:1});
 a.execute({action:'set',bucket:'draft',key:'a',value:'first'});
 expect(()=>a.execute({action:'set',bucket:'draft',key:'b',value:'second'})).toThrow('quota');
 expect(()=>a.execute({action:'set',bucket:'draft',key:'a',value:'x'.repeat(11)})).toThrow('limit');
 expect(a.execute({action:'get',bucket:'draft',key:'a'})).toEqual({value:'first'});
});
it('rejects foreign fields, invalid buckets and symlink entries/directories',()=>{
 const p=fixture(),a=new HelmCodeStorage(p);
 expect(()=>a.execute({action:'get',bucket:'ui',key:'x',root:'/tmp'})).toThrow();
 expect(()=>a.execute({action:'set',bucket:'../',key:'x',value:'x'})).toThrow();
 a.execute({action:'set',bucket:'ui',key:'x',value:'x'});const file=join(p,readdirSync(p)[0]);rmSync(file);symlinkSync('/tmp',file);
 expect(()=>a.execute({action:'get',bucket:'ui',key:'x'})).toThrow();
 const link=join(fixture(),'link');symlinkSync(p,link);expect(()=>new HelmCodeStorage(link)).toThrow();
});

it('rejects nonstring action and bucket without creating any disk entries',()=>{
 const p=fixture(),store=new HelmCodeStorage(p);
 for(const value of [['get'],['set'],['ui'],{},null,1,true]){
  expect(()=>store.execute({action:value,bucket:'ui',key:'x',value:'bad'})).toThrow();
  expect(()=>store.execute({action:'set',bucket:value,key:'x',value:'bad'})).toThrow();
 }
 expect(readdirSync(p)).toEqual([]);
});
it('collects only orphan blobs on startup, preserving shared references until all drafts are removed',()=>{
 const p=fixture(),a=new HelmCodeStorage(p),blob=JSON.stringify({mime:'image/png',data:'YQ=='});
 a.execute({action:'set',bucket:'blob',key:'shared',value:blob});
 for(const key of ['one','two'])a.execute({action:'set',bucket:'draft',key,value:JSON.stringify({prompt:[{blob:{id:'shared'}}]})});
 a.execute({action:'remove',bucket:'draft',key:'one'});
 const b=new HelmCodeStorage(p);expect(b.execute({action:'get',bucket:'blob',key:'shared'})).toEqual({value:blob});
 b.execute({action:'remove',bucket:'draft',key:'two'});
 expect(new HelmCodeStorage(p).execute({action:'get',bucket:'blob',key:'shared'})).toEqual({value:null});
});
it('does not delete any blobs when a draft or stored record is malformed',()=>{
 for(const corruptRecord of [false,true]){
  const p=fixture(),a=new HelmCodeStorage(p),blob=JSON.stringify({mime:'image/png',data:'YQ=='});
  a.execute({action:'set',bucket:'blob',key:'orphan',value:blob});
  a.execute({action:'set',bucket:'draft',key:'bad',value:'invalid json'});
  if(corruptRecord)writeFileSync(join(p,'a'.repeat(64)+'.json'),'broken');
  expect(new HelmCodeStorage(p).execute({action:'get',bucket:'blob',key:'orphan'})).toEqual({value:blob});
 }
});
