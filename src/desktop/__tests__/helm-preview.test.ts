import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HelmPreview, helmPreviewUrl } from '../core/helm-preview.js';
let dir:string,service:HelmPreview,host:ConstructorParameters<typeof HelmPreview>[1];
const emit=vi.fn(),call=vi.fn(),scope=()=>({root:dir,owner:'profile'});
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'helm-preview-'));emit.mockReset();call.mockReset();call.mockResolvedValue({callId:'call',ok:true,value:{tab:{id:'tab',workspaceId:'original-space'}}});host={context:async()=>({workspaceId:'original-space',profile:'profile',sourceRevision:'checked-source'}),client:()=>({emit,call})};service=new HelmPreview(dir,host);});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
it('uses existing task lifecycle and opens once in the original space',async()=>{
 const id=randomUUID(),receipt=await service.open(id,'helm-run','source-check',scope(),'http://localhost:3000/path');
 expect(receipt.status).toBe('opened');expect(receipt.tabId).toBe('tab');
 expect(emit.mock.calls[0]).toEqual(['profile','task.started',expect.objectContaining({runId:receipt.browserRunId,workspaceId:'original-space',task:expect.objectContaining({allowedOrigins:['http://localhost:3000'],readOnly:true})})]);
 expect(call).toHaveBeenCalledWith('profile','browser.openTab',{url:'http://localhost:3000/path',workspaceId:'original-space',background:false},expect.objectContaining({runId:receipt.browserRunId}));
 expect(emit.mock.calls[1]).toEqual(['profile','task.finished',expect.objectContaining({status:'done',summary:expect.stringContaining('not been verified')})]);
 expect(await service.open(id,'helm-run','source-check',scope(),'http://localhost:3000/path')).toEqual(receipt);expect(call).toHaveBeenCalledTimes(1);
});
it('retains lost acknowledgement as unknown and never replays after restart',async()=>{
 call.mockRejectedValue(Error('connection lost'));const id=randomUUID(),receipt=await service.open(id,'run','check',scope(),'http://127.0.0.1:5173');expect(receipt.status).toBe('unknown');
 service=new HelmPreview(dir,host);expect((await service.open(id,'run','check',scope(),'http://127.0.0.1:5173')).status).toBe('unknown');expect(call).toHaveBeenCalledTimes(1);
});
it('retains policy rejection without treating it as an opened tab',async()=>{call.mockResolvedValue({callId:'call',ok:false,error:{code:'denied',message:'Space access denied'}});const receipt=await service.open(randomUUID(),'run','check',scope(),'http://localhost:3000');expect(receipt.status).toBe('unknown');expect(receipt.error).toBe('Space access denied');});
it('requires host-approved source checks, original space and profile before dispatch',async()=>{
 host.context=async()=>{throw Error('Source checks stale');};await expect(service.open(randomUUID(),'run','check',scope(),'http://localhost:3000')).rejects.toThrow('stale');expect(call).not.toHaveBeenCalled();
 host.context=async()=>({workspaceId:'',profile:'profile',sourceRevision:'source'});await expect(service.open(randomUUID(),'run','check',scope(),'http://localhost:3000')).rejects.toThrow('context');
 host.context=async()=>({workspaceId:'space',profile:'other',sourceRevision:'source'});await expect(service.open(randomUUID(),'run','check',scope(),'http://localhost:3000')).rejects.toThrow('context');
});
it.each(['https://example.com:3000','file:///etc/passwd','http://localhost.evil.test:3000','http://user:pass@localhost:3000','http://localhost','javascript:alert(1)'])('rejects nonlocal or unsupported preview URL %s',url=>{expect(()=>helmPreviewUrl(url)).toThrow();});
it('allows explicit IPv6 loopback and preserves path/query',()=>{expect(helmPreviewUrl('http://[::1]:3000/path?q=1')).toBe('http://[::1]:3000/path?q=1');});
it('rejects ID reuse for another URL and cross-profile receipt access',async()=>{const id=randomUUID();await service.open(id,'run','check',scope(),'http://localhost:3000');await expect(service.open(id,'run','check',scope(),'http://localhost:4000')).rejects.toThrow('another request');expect(()=>service.get(id,{...scope(),owner:'other'})).toThrow('scope');});
it('does not duplicate a simultaneous request',async()=>{const id=randomUUID();await Promise.allSettled([service.open(id,'run','check',scope(),'http://localhost:3000'),service.open(id,'run','check',scope(),'http://localhost:3000')]);expect(call).toHaveBeenCalledTimes(1);});
it('recovers an opening journal as unknown without replay',async()=>{const id=randomUUID();await service.open(id,'run','check',scope(),'http://localhost:3000');const file=join(dir,'helm','previews',id+'.json'),raw=JSON.parse(readFileSync(file,'utf8'));writeFileSync(file,JSON.stringify({...raw,status:'opening'}));service=new HelmPreview(dir,host);expect(service.get(id,scope()).status).toBe('unknown');expect(service.list('run',scope())).toHaveLength(1);expect(call).toHaveBeenCalledTimes(1);});
it('fails closed if the Browser acknowledges a different space',async()=>{call.mockResolvedValue({callId:'call',ok:true,value:{tab:{id:'tab',workspaceId:'wrong'}}});expect((await service.open(randomUUID(),'run','check',scope(),'http://localhost:3000')).status).toBe('unknown');});
