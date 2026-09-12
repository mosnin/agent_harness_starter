// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ChatWorkActivity } from "../ui/chat-work-activity";
const settle=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
const components:ChatWorkActivity[]=[];
afterEach(()=>{components.splice(0).forEach(c=>c.dispose());document.body.replaceChildren();vi.useRealTimers();});
function fixture(){
 const host=document.createElement("div");document.body.append(host);
 const session={id:"chat",root:"/project",delegatedWork:["goal"],helmRuns:["run"],orcaIntents:[{id:"orca"}]};
 const goal={id:"goal",root:"/project",objective:"Implement search",status:"running",tasks:[{id:"t",title:"API",status:"completed",answer:"<safe result>",evidence:[{path:"api.ts"}]}]};
 const rpc=vi.fn(async(method:string,args:any):Promise<any>=>{if(method==="session.get")return session;if(method==="work.get")return goal;if(method==="helm.get")return {id:"run",root:"/project",title:"Search UI",status:"needs_review",output:"Patch ready"};if(method==="helm.orca.get")return {id:"orca",root:"/project",input:{prompt:"Check query"},state:"unknown"};if(method==="helm.orca.read")return {output:"Partial worker output"};return {};});
 const component=new ChatWorkActivity(rpc,vi.fn(),vi.fn());components.push(component);
 component.mount(host,{id:"chat",profile:"p",root:"/project"});return {host,session,goal,rpc,component};
}
it("restores only session-linked tasks and readable answers/evidence without forms",async()=>{
 const f=fixture();await settle();expect(f.host.textContent).toContain("Implement search");expect(f.host.textContent).toContain("<safe result>");expect(f.host.querySelector("safe")).toBeNull();expect(f.host.textContent).toContain("api.ts");expect(f.host.textContent).toContain("Outcome uncertain");expect(f.host.querySelector("form")).toBeNull();expect(f.rpc.mock.calls.some(([method])=>method==="work.list")).toBe(false);
});
it("stops an owned task once and preserves disclosures/focus on refresh",async()=>{
 const f=fixture();await settle();const detail=f.host.querySelector<HTMLDetailsElement>('details[data-task="goal"]')!;detail.open=true;detail.dispatchEvent(new Event("toggle"));
 let release!:()=>void;f.rpc.mockImplementation(async(method:string)=>{if(method==="work.stop")await new Promise<void>(resolve=>{release=resolve;});if(method==="session.get")return f.session;if(method==="work.get")return f.goal;if(method==="helm.get")return {id:"run",root:"/project",status:"verified"};if(method==="helm.orca.get")return {id:"orca",root:"/project",state:"unknown"};return {};});
 const stop=f.host.querySelector<HTMLButtonElement>('[data-chat-work="stop"][data-id="goal"]')!;stop.click();stop.click();await settle();expect(f.rpc.mock.calls.filter(([method])=>method==="work.stop")).toHaveLength(1);release();await settle();expect(f.host.querySelector<HTMLDetailsElement>('details[data-task="goal"]')!.open).toBe(true);
 const refresh=f.host.querySelector<HTMLElement>('[data-chat-work="refresh"]')!;refresh.focus();await f.component.refresh();expect(document.activeElement?.id).toBe("chat-work-refresh-all");
});
it("late old-scope responses do not populate another conversation and dispose stops polling",async()=>{
 vi.useFakeTimers();const f=fixture();await settle();let release!:(v:any)=>void;
 f.rpc.mockImplementation(async method=>method==="session.get"?new Promise(resolve=>{release=resolve;}):{});
 const pending=f.component.refresh();await settle();f.component.mount(f.host,undefined);release(f.session);await pending;expect(f.host.textContent).toBe("");f.component.dispose();expect(vi.getTimerCount()).toBe(0);
});
it("reads Orca output inline without launching or redirecting",async()=>{const f=fixture();await settle();f.host.querySelector<HTMLButtonElement>('[data-chat-work="read"]')!.click();await settle();expect(f.host.textContent).toContain("Partial worker output");expect(f.rpc.mock.calls.some(([method])=>method.includes("start"))).toBe(false);});

it("polls acknowledged Orca state and retains explicit output through refresh",async()=>{
 const f=fixture();await settle();const original=f.rpc.getMockImplementation()!;
 f.rpc.mockImplementation(async(method,args)=>method==="helm.orca.get"?{id:"orca",root:"/project",state:"ready",dispatchId:"dispatch",input:{prompt:"Owned worker"}}:method==="helm.orca.refresh"?{id:"orca",root:"/project",state:"ready",dispatchId:"dispatch",input:{prompt:"Owned worker"}}:original(method,args));
 await f.component.refresh();expect(f.rpc.mock.calls.some(([method])=>method==="helm.orca.refresh")).toBe(true);
 f.host.querySelector<HTMLButtonElement>('[data-chat-work="read"]')!.click();await settle();await f.component.refresh();expect(f.host.textContent).toContain("Partial worker output");
});
