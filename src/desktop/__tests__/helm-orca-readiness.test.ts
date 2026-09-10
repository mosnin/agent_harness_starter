import { expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WorkbenchService } from "../core/workbench-service";
vi.mock("../core/webhook-service", async () => ({ WebhookService: (await import("./fixtures/offline-webhooks")).OfflineWebhookFixture }));
it("validates correct-pin artifacts before advertising or allocating workers", async () => {
 const home=mkdtempSync(join(tmpdir(),"orca-readiness-")), root=join(home,"project"), artifacts=join(home,"artifacts");mkdirSync(root);mkdirSync(artifacts);
 const service=new WorkbenchService(join(home,"data"),()=>{}, {NODE_ENV:"test",HADES_WEBHOOK_PORT:"0",HADES_HELM_ORCA_ARTIFACTS:artifacts});
 const revision="bf4e2705046cf9ef9c915929a9646da85717af07";
 const manifest=join(artifacts,"helm-orca-build.json");
 try {
  await service.dispatch("project.add",{path:root});
  writeFileSync(manifest,JSON.stringify({sourceRevision:revision,files:[]}));
  expect(await service.dispatch("helm.orca.info",{root})).toMatchObject({state:"invalid"});
  await expect(service.dispatch("helm.orca.start",{root,requestId:crypto.randomUUID(),prompt:"Task",agent:"codex"})).rejects.toThrow();
  expect(await service.dispatch("helm.orca.list",{root})).toEqual([]);
  const files=["orcad.js","daemon-entry.js","parcel-watcher-process-entry.js"].map(path=>{writeFileSync(join(artifacts,path),"fixture");return {path,sha256:createHash("sha256").update("fixture").digest("hex"),bytes:7};});
  writeFileSync(manifest,JSON.stringify({sourceRevision:revision,files}));
  expect(await service.dispatch("helm.orca.info",{root})).toMatchObject({state:"packaged"});
  writeFileSync(join(artifacts,"orcad.js"),"tampered");
  expect(await service.dispatch("helm.orca.info",{root})).toMatchObject({state:"invalid"});
 } finally {service.close();await new Promise(resolve=>setTimeout(resolve,20));rmSync(home,{recursive:true,force:true});}
});
