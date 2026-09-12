import { describe, expect, it, vi } from "vitest";
import { ComputerControl } from "../core/computer-control";
import { ToolRegistry } from "../../hades/agent/tools";
function setup() {
  let now = 100;
  const invoke = vi.fn(async (_input: Record<string,any>, _signal?: AbortSignal): Promise<Record<string,any>> => ({ pid:123,bundle:"app.test",app:"Test",image:"data:image/png;base64,AAAA",display:{id:1,x:0,y:0,width:100,height:100},apps:[{pid:123,bundle:"app.test"}],elements:[{id:0,path:[1],fingerprint:"button|Save",bounds:{x:3,y:4,width:20,height:10},title:"Save"}] }));
  const control = new ComputerControl(invoke,() => now), signal = new AbortController();
  control.configure(true);
  const registry = new ToolRegistry(); control.tools(signal.signal).forEach(t => registry.register(t));
  const call = (tool:string,input:unknown) => registry.run({tool,input:JSON.stringify(input)});
  const observe = async () => JSON.parse((await call("computer_observe",{})).output).snapshot;
  return {control,invoke,signal,call,observe,advance:() => {now += 120001;}};
}
describe("native computer authority", () => {
  it("does not report success for a late action response after Stop", async () => {
    const s = setup(), snapshot = await s.observe();
    let finish!:(value:Record<string,any>)=>void;
    s.invoke.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const action = s.call("computer_action",{snapshot,action:"press",element:0});
    s.control.stop(); finish({performed:true});
    const result = await action;
    expect(result.ok).toBe(false); expect(result.output).toContain("outcome may be unknown");
    expect((await s.call("computer_action",{snapshot,action:"press",element:0})).ok).toBe(false);
  });
  it("uses an issued one-use element reference, keeps native paths private, and consumes it before dispatch", async () => {
    const s = setup(), result = await s.call("computer_observe",{op:"type",text:"injected"});
    expect(s.invoke.mock.calls[0][0]).toEqual({op:"observe",display:undefined});
    expect(result.images).toHaveLength(1); const observed = JSON.parse(result.output);
    expect(observed.elements[0].path).toBeUndefined(); expect(observed.elements[0].fingerprint).toBeUndefined();
    expect((await s.call("computer_action",{snapshot:observed.snapshot,action:"press",element:0})).ok).toBe(true);
    expect(s.invoke.mock.calls.find(([request]) => request.op === "press")![0]).toMatchObject({op:"press",pid:123,path:[1],fingerprint:"button|Save"});
    expect((await s.call("computer_action",{snapshot:observed.snapshot,action:"press",element:0})).ok).toBe(false);
    expect(s.invoke).toHaveBeenCalledTimes(3);
  });
  it("rejects stale, unissued, out-of-display, cross-turn and revoked references without dispatch", async () => {
    const s = setup(), snapshot = await s.observe();
    expect((await s.call("computer_action",{snapshot,action:"click",x:101,y:10})).ok).toBe(false);
    expect((await s.call("computer_action",{snapshot,action:"press",element:88})).ok).toBe(false);
    s.advance(); expect((await s.call("computer_action",{snapshot,action:"press",element:0})).ok).toBe(false);
    const current = await s.observe(); s.control.configure(false);
    expect((await s.call("computer_action",{snapshot:current,action:"press",element:0})).ok).toBe(false);
    expect(s.invoke).toHaveBeenCalledTimes(2);
    s.control.configure(true);
    const other = new ToolRegistry(); s.control.tools(new AbortController().signal).forEach(t => other.register(t));
    expect((await other.run({tool:"computer_action",input:JSON.stringify({snapshot:current,action:"press",element:0})})).ok).toBe(false);
  });
  it("does not retry an action whose native outcome is unknown", async () => {
    const s = setup(), snapshot = await s.observe();
    s.invoke.mockRejectedValueOnce(new Error("timeout"));
    const request = {snapshot,action:"key",key:"return"};
    expect((await s.call("computer_action",request)).ok).toBe(false);
    expect((await s.call("computer_action",request)).ok).toBe(false);
    expect(s.invoke).toHaveBeenCalledTimes(2);
  });
  it("aborts a pending bridge request on the global stop control", async () => {
    const s = setup(); let aborted = false;
    s.invoke.mockImplementationOnce((_input:any,signal?:AbortSignal) => new Promise((_resolve,reject) => { signal!.addEventListener("abort",() => {aborted = true; reject(new Error("Stopped"));}); }));
    const pending = s.call("computer_observe",{}); s.control.stop();
    expect((await pending).ok).toBe(false); expect(aborted).toBe(true);
  });
  it("refuses concurrent bridge operations instead of queuing stale input", async () => {
    const s = setup(); let finish!:(value:Record<string,any>)=>void;
    s.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = s.call("computer_observe",{});
    const other = new ToolRegistry(); s.control.tools(new AbortController().signal).forEach(t => other.register(t));
    const second = await other.run({tool:"computer_observe",input:"{}"});
    expect(second.ok).toBe(false); expect(second.output).toContain("Another agent");
    expect(s.invoke).toHaveBeenCalledTimes(1);
    s.control.stop(); finish({elements:[]});
    expect((await first).ok).toBe(false);
  });
  it("invalidates another turn's observation after a dispatched action", async () => {
    const s = setup(), firstSnapshot = await s.observe();
    const other = new ToolRegistry(); s.control.tools(new AbortController().signal).forEach(t => other.register(t));
    const secondSnapshot = JSON.parse((await other.run({tool:"computer_observe",input:"{}"})).output).snapshot;
    expect((await s.call("computer_action",{snapshot:firstSnapshot,action:"press",element:0})).ok).toBe(true);
    expect((await other.run({tool:"computer_action",input:JSON.stringify({snapshot:secondSnapshot,action:"press",element:0})})).ok).toBe(false);
    expect(s.invoke).toHaveBeenCalledTimes(4);
  });
});

it("returns fresh one-use targets after an action without replaying it", async()=>{
 const s=setup(),before=await s.observe();
 const result=await s.call("computer_action",{snapshot:before,action:"press",element:0});
 const output=JSON.parse(result.output);expect(output.actionDispatched).toBe(true);expect(output.observation.snapshot).not.toBe(before);expect(result.images).toHaveLength(1);
 expect((await s.call("computer_action",{snapshot:before,action:"press",element:0})).ok).toBe(false);
 expect(s.invoke.mock.calls.filter(([args])=>args.op==="press")).toHaveLength(1);
});
