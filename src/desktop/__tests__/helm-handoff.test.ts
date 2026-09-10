import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HelmHandoffStore, helmHandoffContext } from '../core/helm-handoff.js';
let dir:string,store:HelmHandoffStore;
const input=()=>({requestId:randomUUID(),prompt:'Implement the researched change',notebook:{id:'note',workspaceId:'space',runId:'browser-run',title:'Research',body:'Observed behavior',sources:[{id:'s1',title:'Source',url:'https://example.test/reference',retrievedAt:1,excerpt:'Observed evidence'}]}});
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'helm-handoff-'));store=new HelmHandoffStore(dir);});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
it('preserves source provenance as a draft across restart with private storage',()=>{
 const value=input(),receipt=store.receive(value);store=new HelmHandoffStore(dir);
 expect(store.list()).toEqual([receipt]);expect(receipt.notebook).toEqual(value.notebook);expect(receipt.status).toBe('draft');
 expect(statSync(join(dir,'helm','handoffs',receipt.id+'.json')).mode&0o777).toBe(0o600);
 expect(helmHandoffContext(receipt)).toContain('untrusted data');expect(helmHandoffContext(receipt)).toContain('browser-run');
});
it('replays lost acknowledgements without creating a second draft',()=>{const value=input();const first=store.receive(value);expect(store.receive(value)).toEqual(first);expect(store.list()).toHaveLength(1);});
it('rejects an id reused for changed content',()=>{const value=input();store.receive(value);expect(()=>store.receive({...value,prompt:'different'})).toThrow('different content');});
it.each(['root','owner','profile','provider','agent'])('rejects browser-selected authority %s',field=>{expect(()=>store.receive({...input(),[field]:'injected'})).toThrow('Project');});
it.each(['file:///etc/passwd','javascript:alert(1)','https://user:secret@example.test'])('rejects unsupported evidence URL %s',url=>{const value=input();value.notebook.sources[0].url=url;expect(()=>store.receive(value)).toThrow();});
it('rejects oversized evidence instead of silently truncating sources',()=>{const value=input();value.notebook.body='a'.repeat(64001);expect(()=>store.receive(value)).toThrow('oversized');expect(store.list()).toHaveLength(0);});
it('validates nested keys and invalid source timestamps',()=>{const value=input();expect(()=>store.receive({...value,notebook:{...value.notebook,root:'/tmp'}})).toThrow('fields');value.notebook.sources[0].retrievedAt=NaN;expect(()=>store.receive(value)).toThrow('date');});
it('claims before dispatch, rejects double start, and retains the actual run link',()=>{
 const receipt=store.receive(input());expect(store.claim(receipt.id,{root:dir,owner:'profile'}).status).toBe('starting');
 expect(()=>store.claim(receipt.id,{root:dir,owner:'profile'})).toThrow('already claimed');
 expect(store.complete(receipt.id,'helm-run').runId).toBe('helm-run');expect(store.get(receipt.id).status).toBe('started');
});
it('recovers uncertain start without automatic redispatch or a replacement claim',()=>{
 const receipt=store.receive(input());store.claim(receipt.id,{root:dir,owner:'profile'});store=new HelmHandoffStore(dir);
 expect(store.get(receipt.id).status).toBe('unknown');expect(()=>store.claim(receipt.id,{root:dir,owner:'profile'})).toThrow('already claimed');
});
it('allows only one claim across independent store instances',()=>{
 const receipt=store.receive(input()),other=new HelmHandoffStore(dir);store.claim(receipt.id,{root:dir,owner:'profile'});
 expect(()=>other.claim(receipt.id,{root:dir,owner:'profile'})).toThrow('already claimed');
});
it('recovers a claim written before the draft status transition as unknown',()=>{
 const receipt=store.receive(input());writeFileSync(join(dir,'helm','handoffs',receipt.id+'.claim'),'claimed',{mode:0o600,flag:'wx'});
 store=new HelmHandoffStore(dir);expect(store.get(receipt.id).status).toBe('unknown');
 expect(()=>store.claim(receipt.id,{root:dir,owner:'profile'})).toThrow('already claimed');
});
