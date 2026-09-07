import { describe, expect, it } from "vitest";
import { AgentLoop } from "../agent/loop";
import { ToolRegistry } from "../agent/tools";
import type { ChatRequest, ChatResponse, ModelClient } from "../models/client";

const result = (extra:Partial<ChatResponse>={}) : ChatResponse => ({text:"ANSWER: Complete",tokensIn:100,tokensOut:20,usd:0,model:"fixture",provider:"fixture",...extra});
function harness(script:(index:number,req:ChatRequest)=>ChatResponse|Promise<ChatResponse>) {
 const requests:ChatRequest[]=[],released:string[]=[],effects:string[]=[];
 const client:ModelClient={chat:async req=>{requests.push({...req,messages:req.messages.map(m=>({...m}))});return script(requests.length-1,req);},releaseSession:async id=>{released.push(id);}};
 const tools=new ToolRegistry();tools.register({name:"write",description:"A confined test write",run:input=>{effects.push(input);return {ok:true,output:"Saved"};}});
 return {client,tools,requests,released,effects};
}
const action="TOOL: write\nINPUT: approved test content";
describe("AgentLoop budget and transport lifecycle",()=>{
 it("does not start inference when the whole request cannot fit the explicit budget",async()=>{
  const h=harness(()=>result());const r=await new AgentLoop(h.client,h.tools,{model:"fixture",maxTotalTokens:100}).run("Work");expect(r.error).toContain("token budget");expect(h.requests).toHaveLength(0);expect(h.effects).toHaveLength(0);
 });
 it("charges full measured input and output despite cached input, then stops before another request",async()=>{
  const h=harness(()=>result({text:action,tokensIn:3500,tokensOut:500,cachedInputTokens:3400}));
  const r=await new AgentLoop(h.client,h.tools,{model:"fixture",maxOutputTokens:128,maxTotalTokens:4500}).run("Work");expect(h.requests).toHaveLength(1);expect(h.effects).toHaveLength(1);expect(r.error).toContain("token budget");expect(r.tokensIn+r.tokensOut).toBe(4000);expect(r.cachedInputTokens).toBe(3400);expect(h.released).toEqual([h.requests[0].transportSessionId]);
 });
 it("does not execute a tool when actual provider usage exceeds its budget",async()=>{
  const h=harness(()=>result({text:action,tokensIn:12000,tokensOut:400}));const r=await new AgentLoop(h.client,h.tools,{model:"fixture",maxOutputTokens:128,maxTotalTokens:5000}).run("Work");expect(r.error).toContain("exceeded");expect(r.tokensIn).toBe(12000);expect(h.effects).toHaveLength(0);expect(h.released).toHaveLength(1);
 });
 it("rejects invalid limits and invalid provider accounting before effects",async()=>{
  const h=harness(()=>result());for(const maxTotalTokens of [NaN,Infinity,-1,0,1.5])expect(()=>new AgentLoop(h.client,h.tools,{model:"fixture",maxTotalTokens})).toThrow("Invalid");
  for(const tokensIn of [NaN,Infinity,-1,1.5]){const bad=harness(()=>result({text:action,tokensIn}));const r=await new AgentLoop(bad.client,bad.tools,{model:"fixture"}).run("Work");expect(r.error).toContain("invalid token usage");expect(bad.effects).toHaveLength(0);expect(bad.released).toHaveLength(1);}
 });
 it("keeps one transport identity across iterations and isolates separate runs",async()=>{
  const h=harness(index=>result({text:index%2===0?action:"ANSWER: Verified",cachedInputTokens:50}));const loop=new AgentLoop(h.client,h.tools,{model:"fixture"});const first=await loop.run("Work");await loop.run("Work");
  expect(h.requests[0].tools).toEqual([{name:"write",description:"A confined test write"}]);expect(h.requests[0].transportSessionId).toBe(h.requests[1].transportSessionId);expect(h.requests[2].transportSessionId).not.toBe(h.requests[0].transportSessionId);expect(h.released).toEqual([h.requests[0].transportSessionId,h.requests[2].transportSessionId]);expect(first.cachedInputTokens).toBe(100);
 });
 it("releases transport after step limits, provider errors and context exhaustion",async()=>{
  const capped=harness(()=>result({text:action}));expect((await new AgentLoop(capped.client,capped.tools,{model:"fixture",maxSteps:1}).run("Work")).hitStepLimit).toBe(true);expect(capped.released).toHaveLength(1);
  const failed=harness(()=>{throw Error("Provider disconnected");});expect((await new AgentLoop(failed.client,failed.tools,{model:"fixture"}).run("Work")).error).toContain("disconnected");expect(failed.released).toHaveLength(1);
  const context=harness(()=>result({text:action}));let count=0;const r=await new AgentLoop(context.client,context.tools,{model:"fixture",contextWindow:async()=>++count===1?20000:1}).run("Work");expect(r.error).toContain("Context budget");expect(context.requests).toHaveLength(1);expect(context.released).toHaveLength(1);
 });
 it("releases a cancelled run and prevents the returned pending action",async()=>{
  const controller=new AbortController();const h=harness(()=>{controller.abort();return result({text:action});});const r=await new AgentLoop(h.client,h.tools,{model:"fixture",signal:controller.signal}).run("Work");expect(r.error).toBe("Run cancelled");expect(h.effects).toHaveLength(0);expect(h.released).toHaveLength(1);
 });
 it("releases after a callback exception and does not mask an outcome with cleanup failure",async()=>{
  const h=harness(()=>result({text:action}));await expect(new AgentLoop(h.client,h.tools,{model:"fixture",onTool:()=>{throw Error("UI callback");}}).run("Work")).rejects.toThrow("UI callback");expect(h.released).toHaveLength(1);
  const cleanup=harness(()=>result());cleanup.client.releaseSession=async()=>{throw Error("Already disconnected");};expect((await new AgentLoop(cleanup.client,cleanup.tools,{model:"fixture"}).run("Work")).answer).toBe("Complete");
 });
 it("marks usage incomplete after a failed request while retaining prior measured tokens",async()=>{
  const h=harness(index=>{if(index===0)return result({text:action,tokensIn:100,tokensOut:20});throw Error("Connection lost after inference started");});
  const r=await new AgentLoop(h.client,h.tools,{model:"fixture"}).run("Work");expect(r.usageComplete).toBe(false);expect(r.tokensIn+r.tokensOut).toBe(120);expect(r.error).toContain("Connection lost");
  const done=harness(()=>result());expect((await new AgentLoop(done.client,done.tools,{model:"fixture"}).run("Work")).usageComplete).toBe(true);
  const missing=harness(()=>result({tokensIn:0,tokensOut:0}));expect((await new AgentLoop(missing.client,missing.tools,{model:"fixture"}).run("Work")).usageComplete).toBe(false);
 });
 it("does not turn missing cache reporting into a measured zero",async()=>{
  const h=harness(index=>result({text:index===0?action:"ANSWER: Complete",...(index===0?{cachedInputTokens:100}:{})}));expect((await new AgentLoop(h.client,h.tools,{model:"fixture"}).run("Work")).cachedInputTokens).toBeUndefined();
 });
});
