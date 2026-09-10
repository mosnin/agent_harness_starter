// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HelmOrcaView } from "../ui/helm-orca";
const scope = { root: "/project", profile: "owner" };
let host: HTMLElement, view: HelmOrcaView;
let rpc = vi.fn<(method: string, args?: any) => Promise<any>>();
const settle = async () => { for(let i=0;i<16;i++) await Promise.resolve(); };
const click = (name:string) => host.querySelector<HTMLButtonElement>('[data-orca="'+name+'"]')!.click();
const fill = (id:string,value:string) => { const e=host.querySelector<HTMLInputElement>("#orca-"+id)!;e.value=value;e.dispatchEvent(new Event("input")); };
const submit = () => host.querySelector("form")!.dispatchEvent(new Event("submit",{cancelable:true}));
afterEach(() => { view.dispose(); vi.useRealTimers(); });
const row = (id="worker",state="ready") => ({...scope,id,state,active:true,input:{requestId:id,prompt:"Review the parser",agent:"codex"},dispatchId:"dispatch"});
beforeEach(async()=>{
 document.body.innerHTML="<main></main>";host=document.querySelector("main")!;
 rpc=vi.fn(async(method:string,args:any)=>{
  if(method==="helm.orca.info")return {state:"packaged",message:"Candidate artifact exists",sourceRevision:"abc"};
  if(method==="helm.orca.list")return [];
  if(method==="helm.orca.start")return {...row(args.requestId),input:args};
  return row();
 });
 view=new HelmOrcaView(rpc);view.setScope(scope);view.mount(host);await view.open();
});
it("distinguishes artifact presence from provider readiness and refuses missing start",async()=>{
 expect(host.textContent).toContain("does not confirm provider sign-in");
 rpc.mockImplementationOnce(async()=>({state:"missing",message:"Build the runtime artifact before starting.",sourceRevision:"abc"}));
 await view.open();fill("prompt","Test");submit();await settle();
 expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
 expect(rpc.mock.calls.some(c=>c[0]==="helm.orca.start")).toBe(false);
});
it("uses one exact request across timeout retry and ignores duplicate submit",async()=>{
 fill("prompt","Fix the parser");let reject!:(e:Error)=>void;
 rpc.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r}));
 submit();submit();expect(rpc.mock.calls.filter(c=>c[0]==="helm.orca.start")).toHaveLength(1);
 const first=rpc.mock.calls.find(c=>c[0]==="helm.orca.start")![1];
 reject(Error("Acknowledgement lost"));await settle();
 expect(host.textContent).toContain("Retry same request");expect(host.querySelector<HTMLTextAreaElement>("#orca-prompt")!.disabled).toBe(true);
 submit();await settle();expect(rpc.mock.calls.filter(c=>c[0]==="helm.orca.start")[1][1]).toEqual(first);
 expect(host.textContent).toContain("Dispatch acknowledged");expect(host.textContent).toContain("completion has not been verified");
});
it("selects acknowledged unknown intent and reconciles without another start",async()=>{
 fill("prompt","Fix");rpc.mockImplementationOnce(async(_m:string,a:any)=>row(a.requestId,"unknown"));submit();await settle();
 expect(host.textContent).toContain("Outcome unknown");expect(host.querySelector("form")).toBeNull();
 click("recover");await settle();
 expect(rpc.mock.calls.filter(c=>c[0]==="helm.orca.start")).toHaveLength(1);
 expect(rpc.mock.calls.find(c=>c[0]==="helm.orca.recover")?.[1]).toMatchObject(scope);
});
it("drops stale profile results and restores the old uncertain request",async()=>{
 fill("prompt","Private old prompt");let finish!:(r:any)=>void;
 rpc.mockImplementationOnce(()=>new Promise(r=>{finish=r}));submit();
 const pending=rpc.mock.calls.find(c=>c[0]==="helm.orca.start")![1];
 view.setScope({...scope,profile:"other"});await view.open();finish(row(pending.requestId));await settle();
 expect(host.textContent).not.toContain("Private old prompt");expect(host.textContent).not.toContain("Dispatch acknowledged");
 view.setScope(scope);await view.open();expect(host.textContent).toContain("Retry same request");
});
it("bounds output, invents no cursor, and scopes stop",async()=>{
 rpc.mockImplementationOnce(async()=>({state:"packaged",message:"Artifact",sourceRevision:"abc"}));
 rpc.mockImplementationOnce(async()=>[row()]);await view.open();click("select");await settle();
 rpc.mockImplementationOnce(async()=>({output:"<script>bad</script>"+"x".repeat(40000),truncated:true}));
 click("read");await settle();
 expect(host.querySelector('[aria-label="Orca worker output"]')!.textContent!.length).toBe(32000);
 expect(host.querySelector("script")).toBeNull();
 expect(rpc.mock.calls.find(c=>c[0]==="helm.orca.read")?.[1]).toEqual({...scope,id:"worker"});
 click("stop");await settle();expect(rpc).toHaveBeenCalledWith("helm.orca.stop",{...scope,id:"worker"});
});
it("filters foreign records and preserves form drafts through refresh",async()=>{
 fill("prompt","Draft to keep");
 rpc.mockImplementationOnce(async()=>({state:"packaged",message:"Artifact",sourceRevision:"abc"}));rpc.mockImplementationOnce(async()=>[{...row(),profile:"other"}]);
 await view.open();expect(host.querySelector<HTMLTextAreaElement>("#orca-prompt")!.value).toBe("Draft to keep");expect(host.textContent).not.toContain("Review the parser");
});
it("keeps stop reachable during startup and ignores its late acknowledgement",async()=>{
 fill("prompt","Slow start");let finish!:(r:any)=>void;
 rpc.mockImplementationOnce(()=>new Promise(r=>{finish=r}));submit();
 const request=rpc.mock.calls.find(c=>c[0]==="helm.orca.start")![1];
 expect(host.querySelector<HTMLButtonElement>('[data-orca="stop-pending"]')!.disabled).toBe(false);
 rpc.mockImplementationOnce(async()=>({...row(request.requestId,"stopped"),active:false}));
 click("stop-pending");await settle();
 expect(host.textContent).toContain("Stopped");
 finish(row(request.requestId,"ready"));await settle();
 expect(host.textContent).not.toContain("Dispatch acknowledged");
 expect(rpc).toHaveBeenCalledWith("helm.orca.stop",{...scope,id:request.requestId});
});
it("clears a cancelled unadmitted request without inventing a worker card",async()=>{
 fill("prompt","Queued start");let finish!:(r:any)=>void;
 rpc.mockImplementationOnce(()=>new Promise(r=>{finish=r}));submit();
 const request=rpc.mock.calls.find(c=>c[0]==="helm.orca.start")![1];
 rpc.mockImplementationOnce(async()=>({...scope,id:request.requestId,cancelledBeforeAdmission:true,workerState:"not_found_at_inspection"}));
 click("stop-pending");await settle();
 expect(host.textContent).toContain("Queued request cancelled");expect(host.textContent).not.toContain("Retry same request");
 expect(host.textContent).toContain("No Orca workers in this project");
 finish(row(request.requestId,"ready"));await settle();expect(host.textContent).not.toContain("Dispatch acknowledged");
});
it("rejects malformed preferences before consuming a request identity",async()=>{
 fill("prompt","Task");fill("model","--bad");submit();await settle();
 expect(rpc.mock.calls.some(c=>c[0]==="helm.orca.start")).toBe(false);
 expect(host.querySelector<HTMLInputElement>("#orca-model")!.disabled).toBe(false);
 fill("model","model-name");submit();await settle();
 expect(rpc.mock.calls.filter(c=>c[0]==="helm.orca.start")).toHaveLength(1);
});

it("shows invalid integrity safely while keeping inspection available",async()=>{
 rpc.mockImplementationOnce(async()=>({state:"invalid",message:"<script>rebuild</script>",sourceRevision:"abc"}));
 await view.open();expect(host.textContent).toContain("Runtime integrity check failed");expect(host.querySelector("script")).toBeNull();
 expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
 expect(host.querySelector<HTMLButtonElement>('[data-orca="refresh"]')!.disabled).toBe(false);
});
it("polls only acknowledged workers, preserves drafts, and backs off unchanged records",async()=>{
 vi.useFakeTimers();const records=[{...row(),runId:"run"},{...row("unknown","unknown"),dispatchId:undefined}];
 rpc.mockImplementation(async(method)=>method.endsWith("info")?{state:"packaged"}:method.endsWith("list")?records:records[0]);
 await view.open();fill("prompt","Keep this draft");host.scrollTop=47;
 await vi.advanceTimersByTimeAsync(4000);
 expect(rpc.mock.calls.filter(c=>c[0]==="helm.orca.refresh")).toHaveLength(1);
 expect(rpc.mock.calls.some(c=>c[0]==="helm.orca.recover")).toBe(false);
 expect(host.querySelector<HTMLTextAreaElement>("#orca-prompt")!.value).toBe("Keep this draft");expect(host.scrollTop).toBe(47);
 expect(host.textContent).toContain("1 active · 1 uncertain · 0 need review");
 await vi.advanceTimersByTimeAsync(4000);expect(rpc.mock.calls.filter(c=>c[0]==="helm.orca.refresh")).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(26000);expect(rpc.mock.calls.filter(c=>c[0]==="helm.orca.refresh")).toHaveLength(2);
 view.dispose();await vi.advanceTimersByTimeAsync(60000);expect(rpc.mock.calls.filter(c=>c[0]==="helm.orca.refresh")).toHaveLength(2);
});
it("fences scope changes and late refresh errors without overlapping polls",async()=>{
 vi.useFakeTimers();rpc.mockImplementation(async(method)=>method.endsWith("info")?{state:"packaged"}:[{...row(),runId:"run"}]);await view.open();
 let fail!:(e:Error)=>void;rpc.mockImplementationOnce(()=>new Promise((_,reject)=>{fail=reject}));
 await vi.advanceTimersByTimeAsync(4000);const count=rpc.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(rpc.mock.calls.length).toBe(count);
 view.setScope({...scope,profile:"other"});fail(Error("old private error"));await settle();expect(host.textContent).not.toContain("old private error");
 await vi.advanceTimersByTimeAsync(60000);expect(rpc.mock.calls.length).toBe(count);
});
it("does not poll a detached or hidden panel",async()=>{
 vi.useFakeTimers();rpc.mockImplementation(async(method)=>method.endsWith("info")?{state:"packaged"}:[row()]);await view.open();
 host.hidden=true;const count=rpc.mock.calls.length;await vi.advanceTimersByTimeAsync(4000);expect(rpc.mock.calls.length).toBe(count);
 view.mount(undefined);await vi.advanceTimersByTimeAsync(60000);expect(rpc.mock.calls.length).toBe(count);
});
