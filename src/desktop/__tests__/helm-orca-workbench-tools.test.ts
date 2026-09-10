import { expect,it,vi } from 'vitest';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkbenchService,type WorkbenchEvent } from '../core/workbench-service';
vi.mock("../core/webhook-service", async () => ({ WebhookService: (await import("./fixtures/offline-webhooks")).OfflineWebhookFixture }));
const pause=()=>new Promise(r=>setTimeout(r,20));
function create(data:string,events:WorkbenchEvent[]=[]){return new WorkbenchService(data,e=>events.push(e),{NODE_ENV:'test',HADES_WEBHOOK_PORT:'0',HADES_HELM_ORCA_ARTIFACTS:join(data,'missing')});}
it('actual Workbench persists caller-key UUID before lost return and reuses it after restart',async()=>{
 const home=mkdtempSync(join(tmpdir(),'orca-tools-host-')),root=join(home,'project'),data=join(home,'data');mkdirSync(root);let service=create(data);const input=JSON.stringify({key:'stable',prompt:'Fix fixture',agent:'codex'});
 try{await service.dispatch('project.add',{path:root});const session=await service.dispatch('session.new',{root}) as {id:string};vi.spyOn((service as any).helmOrcaRuntime,'validateArtifacts').mockReturnValue(undefined);const start=vi.spyOn((service as any).helmOrca,'start').mockRejectedValue(new Error('lost return'));const tools=(service as any).orcaSessionTools(session.id,'default',root,new AbortController().signal);expect((await tools.find((t:any)=>t.name==='helm_orca_start').run(input)).ok).toBe(false);const uuid=(start.mock.calls[0][1] as {requestId:string}).requestId;service.close();await pause();service=create(data);vi.spyOn((service as any).helmOrcaRuntime,'validateArtifacts').mockReturnValue(undefined);const again=vi.spyOn((service as any).helmOrca,'start').mockResolvedValue({state:'unknown'});const reopened=(service as any).orcaSessionTools(session.id,'default',root,new AbortController().signal);await reopened.find((t:any)=>t.name==='helm_orca_start').run(input);expect((again.mock.calls[0][1] as {requestId:string}).requestId).toBe(uuid);expect((service as any).settings.sessionMeta[session.id].orcaIntents).toHaveLength(1);}
 finally{service.close();await pause();rmSync(home,{recursive:true,force:true});}
});
it('actual Workbench withholds all Orca tools from restricted and child sessions',async()=>{
 const home=mkdtempSync(join(tmpdir(),'orca-tools-host-')),root=join(home,'project');mkdirSync(root);const service=create(join(home,'data'));
 try{await service.dispatch('project.add',{path:root});const session=await service.dispatch('session.new',{root}) as {id:string};for(const patch of [{source:'helm'},{toolAllowlist:['file_ops']},{workGoal:'parent'}]){const meta=(service as any).settings.sessionMeta[session.id];delete meta.source;delete meta.toolAllowlist;delete meta.workGoal;Object.assign(meta,patch);expect((service as any).orcaSessionTools(session.id,'default',root,new AbortController().signal)).toEqual([]);}}
 finally{service.close();await pause();rmSync(home,{recursive:true,force:true});}
});
it('actual conversation registry requires approval before Orca start allocation',async()=>{
 const home=mkdtempSync(join(tmpdir(),'orca-tools-host-')),root=join(home,'project');mkdirSync(root);const events:WorkbenchEvent[]=[];const service=create(join(home,'data'),events);
 try{await service.dispatch('project.add',{path:root});await service.dispatch('profile.save',{id:'default',name:'Fixture',provider:'local',model:'fixture',baseUrl:'https://unused.invalid/v1'});let turn=0;vi.spyOn(service as any,'client').mockReturnValue({chat:async()=>({text:++turn===1?'TOOL: helm_orca_start\nINPUT: {"key":"one","prompt":"Fix fixture","agent":"codex"}':'ANSWER: Work not started.',tokensIn:1,tokensOut:1,usd:0,model:'fixture',provider:'fixture',costMeasured:false})});const start=vi.spyOn((service as any).helmOrca,'start');const session=await service.dispatch('session.new',{root}) as {id:string};await service.dispatch('chat.send',{id:session.id,input:'Start the fixture'});await vi.waitFor(()=>expect(events.some(e=>e.kind==='desktop.approval')).toBe(true));expect(start).not.toHaveBeenCalled();await service.dispatch('approval.reply',{id:events.find(e=>e.kind==='desktop.approval')!.id,allow:false});await vi.waitFor(()=>expect(events.some(e=>e.kind==='desktop.done')).toBe(true));expect((service as any).settings.sessionMeta[session.id].orcaIntents).toBeUndefined();expect(start).not.toHaveBeenCalled();}
 finally{service.close();await pause();rmSync(home,{recursive:true,force:true});}
});
