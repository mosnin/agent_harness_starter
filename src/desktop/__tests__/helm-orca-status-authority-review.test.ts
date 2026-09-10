import { expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HelmOrcaService } from '../core/helm-orca-service';
// Actual service/SQLite; modeled pinned workerShow transport, no daemon/listener/provider.
for (const contradiction of ['missing-worker','dispatch','runtime','base','valid'] as const) {
 it(`does not release capacity from ${contradiction} workerShow identity`,async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'orca-status-authority-'))),scope={root,profile:'p'},base='a'.repeat(40);
  const worker={dispatchId:contradiction==='dispatch'?'foreign':'dispatch',runtimeEpoch:contradiction==='runtime'?'foreign':'runtime',startOptions:{baseBranch:contradiction==='base'?'b'.repeat(40):base}};
  const service=new HelmOrcaService(join(root,'state'),{resolveBase:async()=>base,connect:async()=>({runtimeId:'runtime',repo:'repo',coordinator:'coordinator',call:async(method:string)=>{
   if(method==='orchestration.runCreate')return {run:{id:'run'}};
   if(method==='orchestration.workerStart')return {state:'ready',dispatchId:'dispatch'};
   if(method==='orchestration.workerShow')return {dispatch:{id:'dispatch'},...(contradiction==='missing-worker'?{}:{worker}),observation:{exactWorker:true,status:'exited'}};
   throw Error('Unexpected method '+method);
  }})});
  try{
   const id=randomUUID();await service.start(scope,{requestId:id,prompt:'fixture',agent:'codex'});
   try{await service.status(scope,id);}catch{/* A fail-closed identity rejection is also acceptable. */}
   const retained=service.get(scope,id);
   expect(retained.active).toBe(contradiction!=='valid');
   expect(service.hasActiveWork()).toBe(contradiction!=='valid');
   if(contradiction!=='valid')expect(retained.state).not.toBe('needs_review');
  }finally{await service.close();rmSync(root,{recursive:true,force:true});}
 });
}
