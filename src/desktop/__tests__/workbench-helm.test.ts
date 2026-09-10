import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkbenchService } from "../core/workbench-service";
const directories: string[] = [], services: WorkbenchService[] = [], servers: Server[] = [];
afterEach(() => { services.splice(0).forEach(s => s.close()); servers.splice(0).forEach(s => { s.closeAllConnections(); s.close(); }); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "helm-workbench-")); directories.push(directory);
  const root = join(directory, "project"); mkdirSync(root); writeFileSync(join(root, "code.js"), "original\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Helm test", "-c", "user.email=helm@example.invalid", "commit", "-qm", "fixture"]]) execFileSync("git", args, { cwd: root });
  const binary = join(directory, "fake-codex");
  writeFileSync(binary, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('fixture 1');else{require('node:fs').writeFileSync('model.txt',process.argv[process.argv.indexOf('--model')+1]||'default');require('node:fs').writeFileSync('code.js','changed\\n');console.log(JSON.stringify({type:'turn.completed'}));}\n`); chmodSync(binary, 0o700);
  const events: any[] = [], requests: any[] = [];
  const server = createServer((req, res) => { let raw = ""; req.on("data", chunk => raw += chunk); req.on("end", () => {
    const request = JSON.parse(raw); requests.push(request);
    const content = !request.messages[0].content.includes("- helm_delegate:") ? "ANSWER: Inspected the isolated code without additional delegation." : /^TOOL_(RESULT|ERROR):/.test(request.messages.at(-1).content) ? "ANSWER: Delegated. Inspect Helm for the result." : 'TOOL: helm_delegate\nINPUT: {"agent":"codex","prompt":"Fix the code","model":"fixture-selected-model","maxMinutes":1}';
    res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
  }); }); servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const service = new WorkbenchService(join(directory, "data"), event => events.push(event), { ...process.env, NODE_ENV: "test", HADES_WEBHOOK_PORT: "0", HADES_BROWSER_RUNTIME: "0", HADES_HELM_CODEX_BIN: binary }); services.push(service);
  await service.dispatch("project.add", { path: root });
  await service.dispatch("profile.save", { id: "default", name: "Test", provider: "local", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` });
  return { service, root, events, requests };
}
it("routes an approved agent delegation to an isolated CLI run with durable ownership and context", async () => {
  const { service, root, events } = await fixture();
  await service.dispatch("helm.context.save", { root, title: "Rule", body: "Keep exports stable", kind: "constraint" });
  const session: any = await service.dispatch("session.new", { root });
  await service.dispatch("chat.send", { id: session.id, input: "Delegate the coding change" });
  await vi.waitFor(() => expect(events.some(e => e.kind === "desktop.approval" && e.tool === "helm_delegate")).toBe(true));
  expect(await service.dispatch("helm.list", { root })).toEqual([]);
  const approval = events.find(e => e.kind === "desktop.approval"); await service.dispatch("approval.reply", { id: approval.id, allow: true });
  let run: any;
  await vi.waitFor(async () => { run = (await service.dispatch("helm.list", { root }) as any[])[0]; expect(run?.status).toBe("needs_review"); }, { timeout: 5000 });
  expect(run.model).toBe("fixture-selected-model"); expect(readFileSync(join(run.workspace, "model.txt"), "utf8")).toBe("fixture-selected-model");
  expect(run.parentSession).toBe(session.id); expect(run.contextSnapshot).toContain("Keep exports stable");
  expect(readFileSync(join(root, "code.js"), "utf8")).toBe("original\n"); expect(readFileSync(join(run.workspace, "code.js"), "utf8")).toBe("changed\n");
  expect(await service.dispatch("session.get", { id: session.id })).toMatchObject({ helmRuns: [run.id], helmReserved: { runs: 1, minutes: 1 } });
  const other: any = await service.dispatch("profile.save", { name: "Other", provider: "local", model: "fixture", baseUrl: "http://127.0.0.1:1/v1" });
  await expect(service.dispatch("helm.get", { id: run.id, profile: other.id })).rejects.toThrow(/own/);
  await expect(service.dispatch("helm.cancel", { id: run.id, profile: other.id })).rejects.toThrow(/own/);
  expect((await service.dispatch("helm.diff", { id: run.id, profile: "default" }) as any).text).toContain("+changed");
});
it("declining Helm delegation creates no task or reservation", async () => {
  const { service, root, events } = await fixture(); const session: any = await service.dispatch("session.new", { root });
  await service.dispatch("chat.send", { id: session.id, input: "Delegate" });
  await vi.waitFor(() => expect(events.some(e => e.kind === "desktop.approval")).toBe(true));
  await service.dispatch("approval.reply", { id: events.find(e => e.kind === "desktop.approval").id, allow: false });
  await vi.waitFor(() => expect(events.some(e => e.kind === "desktop.done" && e.session === session.id)).toBe(true));
  expect(await service.dispatch("helm.list", { root })).toEqual([]); expect((await service.dispatch("session.get", { id: session.id }) as any).helmReserved).toBeUndefined();
  expect(existsSync(join(root, "changed"))).toBe(false);
});
it("runs the built-in Hades agent in the task worktree with a restricted durable tool scope", async () => {
  const { service, root, requests } = await fixture();
  const started: any = await service.dispatch("helm.start", { root, profile: "default", agent: "hades", prompt: "Inspect this code", maxMinutes: 1 });
  let run: any;
  await vi.waitFor(async () => { run = await service.dispatch("helm.get", { id: started.id }); expect(["needs_review", "failed"].includes(run.status)).toBe(true); }, { timeout: 4000 });
  expect(run.status, JSON.stringify({ error: run.error, output: run.output, workspace: run.workspace })).toBe("needs_review");
  expect(run.sessionId).toBeTruthy();
  const session: any = await service.dispatch("session.get", { id: run.sessionId });
  expect(session.source).toBe("helm"); expect(session.root).toBe(run.workspace);
  expect(session.toolAllowlist).toContain("file_ops"); expect(session.toolAllowlist).not.toContain("helm_delegate"); expect(session.toolAllowlist).not.toContain("delegate_work");
  expect(requests[0].messages[0].content).not.toContain("- helm_delegate:");
  expect((await service.dispatch("helm.list", { root }) as any[])).toHaveLength(1);
});

it("accepts the same 200-character model limit through the native start API", async () => {
  const { service, root } = await fixture(); const model = "m".repeat(200);
  const started: any = await service.dispatch("helm.start", { root, agent: "codex", prompt: "Inspect code", model, maxMinutes: 1 });
  await vi.waitFor(async () => expect((await service.dispatch("helm.get", { id: started.id }) as any).status).toBe("needs_review"));
  expect((await service.dispatch("helm.get", { id: started.id }) as any).model).toBe(model);
  await expect(service.dispatch("helm.start", { root, agent: "codex", prompt: "Inspect code", model: "m".repeat(201) })).rejects.toThrow();
});


it("keeps Browser draft admission idempotent and binds explicit coding selection", async () => {
  const {service,root}=await fixture();
  const input={requestId:randomUUID(),prompt:"Implement this notebook",notebook:{id:"note-1",workspaceId:"browser-space",runId:"browser-run",title:"Research",body:"Keep the source evidence",sources:[{id:"s1",title:"Source",url:"https://example.test/reference",retrievedAt:1,excerpt:"Observed content"}]}};
  const receipt:any=await service.dispatch("browser.helmDraft",input);
  expect(await service.dispatch("browser.helmDraft",input)).toEqual(receipt);
  expect(await service.dispatch("helm.list",{root})).toEqual([]);
  await expect(service.dispatch("helm.start",{root,profile:"default",agent:"invalid",prompt:"Implement",handoffId:receipt.id,maxMinutes:1})).rejects.toThrow();
  expect((await service.dispatch("helm.handoff.list",{profile:"default"}) as any[])[0].status).toBe("draft");
  const attempts=await Promise.allSettled([1,2].map(()=>service.dispatch("helm.start",{root,profile:"default",agent:"codex",prompt:"Implement",handoffId:receipt.id,maxMinutes:1})));
  expect(attempts.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  let runs:any[]=[];await vi.waitFor(async()=>{runs=await service.dispatch("helm.list",{root}) as any[];expect(runs[0]?.status).toBe("needs_review");});
  expect(runs).toHaveLength(1);expect(runs[0].handoffId).toBe(receipt.id);expect(runs[0].contextSnapshot).toContain("browser-run");expect(runs[0].contextSnapshot).toContain("https://example.test/reference");
  expect((await service.dispatch("helm.handoff.list",{profile:"default"}) as any[])[0]).toMatchObject({status:"started",runId:runs[0].id});
  const other:any=await service.dispatch("profile.save",{name:"Other",provider:"local",model:"fixture",baseUrl:"http://127.0.0.1:1/v1"});
  expect(await service.dispatch("helm.handoff.list",{profile:other.id})).toEqual([]);
  await expect(service.dispatch("browser.helmDraft",{...input,root})).rejects.toThrow(/fields/);
});

it("requires verified source review through owned RPC and retains its application receipt",async()=>{
  const {service,root}=await fixture();
  const run:any=await service.dispatch("helm.start",{root,agent:"codex",prompt:"Fix",maxMinutes:1});
  await vi.waitFor(async()=>expect((await service.dispatch("helm.get",{id:run.id}) as any).status).toBe("needs_review"));
  await expect(service.dispatch("helm.integration.prepare",{id:run.id})).rejects.toThrow(/Verify/);
  await service.dispatch("helm.verify",{id:run.id,checks:[{command:process.execPath,args:["-e","if(require('fs').readFileSync('code.js','utf8')!=='changed\\n')process.exit(1)"]}]});
  const review:any=await service.dispatch("helm.integration.prepare",{id:run.id});
  expect(readFileSync(join(root,"code.js"),"utf8")).toBe("original\n");
  expect((await service.dispatch("helm.integration.list",{id:run.id}) as any[])[0].id).toBe(review.id);
  const patchDigest=createHash("sha256").update(review.patch).digest("hex");
  const applied:any=await service.dispatch("helm.integration.apply",{id:run.id,reviewId:review.id,patchDigest});
  expect(applied).toMatchObject({status:"applied",requiresSourceChecks:true});
  expect(readFileSync(join(root,"code.js"),"utf8")).toBe("changed\n");
  expect(await service.dispatch("helm.integration.apply",{id:run.id,reviewId:review.id,patchDigest})).toEqual(applied);
  const source:any=await service.dispatch("helm.source.start",{id:run.id,reviewId:review.id,checks:[{command:process.execPath,args:["-e","if(require('fs').readFileSync('code.js','utf8')!=='changed\\n')process.exit(1)"]}],maxSeconds:10});
  await vi.waitFor(async()=>expect((await service.dispatch("helm.source.get",{id:run.id,reviewId:review.id,sourceCheckId:source.id}) as any).status).toBe("passed"),{timeout:5000});
  await expect(service.dispatch("helm.preview.open",{id:run.id,sourceCheckId:source.id,requestId:randomUUID(),url:"http://127.0.0.1:3000"})).rejects.toThrow(/originating Browser/);
  writeFileSync(join(root,"code.js"),"later source change\n");
  expect((await service.dispatch("helm.source.get",{id:run.id,reviewId:review.id,sourceCheckId:source.id}) as any).status).toBe("stale");
});
