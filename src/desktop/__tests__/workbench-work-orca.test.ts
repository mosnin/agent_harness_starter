import { expect, it, vi } from 'vitest';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkbenchService } from '../core/workbench-service';
vi.mock('../core/webhook-service',async()=>({WebhookService:(await import('./fixtures/offline-webhooks')).OfflineWebhookFixture}));

it('actual Workbench Work engine route rejects missing artifacts before attempt reservation or Orca intent',async()=>{
 const home=mkdtempSync(join(tmpdir(),'workbench-orca-work-')),root=join(home,'project');mkdirSync(root);
 const service=new WorkbenchService(join(home,'data'),()=>{},{NODE_ENV:'test',HADES_WEBHOOK_PORT:'0',HADES_HELM_ORCA_ARTIFACTS:join(home,'missing')});
 try{
  await service.dispatch('project.add',{path:root});
  const g:any=await service.dispatch('work.create',{root,objective:'Offline fixture',tasks:[{title:'Build',prompt:'Build fixture',engine:{kind:'orca',agent:'codex'}}]});
  await service.dispatch('work.run',{id:g.id});let result:any;
  for(let i=0;i<50;i++){result=await service.dispatch('work.get',{id:g.id});if(result.status!=='running')break;await new Promise(r=>setTimeout(r,2));}
  expect(result.status).toBe('needs_review');expect(result.error).toMatch(/not included|artifact/i);
  expect(result.tasks[0].attempts).toEqual([]);expect(result.tasks[0].reservedTokens??0).toBe(0);expect(result.tasks[0].engine.dispatchIntent).toBeUndefined();
  expect(await service.dispatch('helm.orca.list',{root})).toEqual([]);
 }finally{await service.close();rmSync(home,{recursive:true,force:true});}
});
