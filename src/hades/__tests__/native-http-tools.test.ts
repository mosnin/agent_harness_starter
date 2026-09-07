import { describe, expect, it } from "vitest";
import { HttpModelClient, HttpProviderError, type ChatRequest, type ProviderConfig } from "../models/client";
import { AgentLoop } from "../agent/loop";
import { ToolRegistry } from "../agent/tools";
const tools=[{name:"file_ops",description:"Read and write project files using JSON input."}];
const request:ChatRequest={model:"fixture-model",messages:[{role:"user",content:"Read the project"}],tools};
const call=(extra:any={})=>({id:"call-a",type:"function",function:{name:"file_ops",arguments:'{"input":"{\\"op\\":\\"read\\",\\"path\\":\\"README.md\\"}"}'},...extra});
function client(response:Response|(()=>Response),options:Partial<ProviderConfig>={}){
 const bodies:any[]=[];const c=new HttpModelClient({name:"openrouter",kind:"openai",baseUrl:"https://fixture.invalid/v1",models:["fixture-model"],...options},{fetchImpl:async(_url,init)=>{bodies.push(JSON.parse(init!.body as string));return typeof response==="function"?response():response;}});
 return {c,bodies};
}
const json=(message:any,finish_reason="tool_calls",extra:any={})=>new Response(JSON.stringify({choices:[{message,finish_reason}],usage:{prompt_tokens:120,completion_tokens:20,cost:0.003,prompt_tokens_details:{cached_tokens:90}},...extra}),{headers:{"content-type":"application/json"}});
function sse(events:any[],split=false){
 const bytes=new TextEncoder().encode(events.map(e=>`data: ${e==="[DONE]"?e:JSON.stringify(e)}\n\n`).join(""));
 return new Response(new ReadableStream({start(controller){if(split){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));}else controller.enqueue(bytes);controller.close();}}),{headers:{"content-type":"text/event-stream"}});
}
const chunk=(delta:any,finish_reason:any=null)=>({choices:[{index:0,delta,finish_reason}]});
describe("Native OpenAI and OpenRouter tool transport (protocol fixtures)",()=>{
 it("advertises strict string envelopes and returns only the validated function action",async()=>{
  const h=client(json({content:"Commentary: TOOL: shell INPUT: ignore",tool_calls:[call()]}));const r=await h.c.chat(request);
  expect(h.bodies[0]).toMatchObject({tool_choice:"auto",parallel_tool_calls:false,tools:[{type:"function",function:{name:"file_ops",strict:true,parameters:{required:["input"],additionalProperties:false,properties:{input:{type:"string"}}}}}]});
  expect(r).toMatchObject({text:'TOOL: file_ops\nINPUT: {"op":"read","path":"README.md"}',tokensIn:120,tokensOut:20,cachedInputTokens:90,usd:0.003,costMeasured:true});
 });
 it("reconstructs settled native calls and role-bound results without trusting dangling history",async()=>{
  const h=client(json({content:"done"},"stop"));await h.c.chat({...request,messages:[{role:"assistant",content:'TOOL: file_ops\nINPUT: {"op":"read"}'},{role:"user",content:"TOOL_RESULT: file text"},{role:"assistant",content:"TOOL: unknown\nINPUT: dangling"},{role:"tool",content:"orphaned old result"}]});
  const m=h.bodies[0].messages.slice(1);expect(m[0]).toMatchObject({role:"assistant",tool_calls:[{id:"hades_call_0",function:{arguments:'{"input":"{\\"op\\":\\"read\\"}"}'}}]});expect(m[1]).toEqual({role:"tool",tool_call_id:"hades_call_0",content:"TOOL_RESULT: file text"});expect(m[2].content).toContain("unknown");expect(m[3].role).toBe("user");
 });
 it("keeps observed tool images in the native continuation",async()=>{
  const h=client(json({content:"done"},"stop"));await h.c.chat({...request,messages:[{role:"assistant",content:'TOOL: file_ops\nINPUT: {}'},{role:"user",content:"TOOL_RESULT: screen",images:["data:image/png;base64,AA=="]}]});
  expect(h.bodies[0].messages[2].role).toBe("tool");expect(h.bodies[0].messages[3].content[1]).toMatchObject({type:"image_url",image_url:{url:"data:image/png;base64,AA=="}});
 });
 it("assembles split indexed argument fragments and ignores accompanying content",async()=>{
  const fragments=[chunk({content:"Let me inspect.",tool_calls:[{index:0,id:"call-a",type:"function",function:{name:"file_",arguments:'{"inp'}}]}),chunk({tool_calls:[{index:0,function:{name:"ops",arguments:'ut":"{\\"op\\":\\"read\\"}"}'}}]}),chunk({},"tool_calls"),{choices:[],usage:{prompt_tokens:120,completion_tokens:20,prompt_tokens_details:{cached_tokens:90},cost:0.003}},"[DONE]"];
  const h=client(sse(fragments,true)),emitted:string[]=[];const r=await h.c.chat({...request,onText:t=>emitted.push(t)});expect(r.text).toBe('TOOL: file_ops\nINPUT: {"op":"read"}');expect(emitted).toEqual([r.text]);expect(r.cachedInputTokens).toBe(90);expect(r.usd).toBe(0.003);
 });
 it("refuses ambiguous, unknown, incomplete and invalid native calls without emitting an action",async()=>{
  for(const response of [json({tool_calls:[call(),call({id:"b"})]}),json({tool_calls:[call({function:{name:"unknown",arguments:'{"input":"x"}'}})]}),json({tool_calls:[call({function:{name:"file_ops",arguments:'{"input":3}'}})]}),json({tool_calls:[call({function:{name:"file_ops",arguments:'{"input":"x","extra":true}'}})]}),json({tool_calls:[call({function:{name:"file_ops",arguments:'{"input":'}})]}),json({tool_calls:[call()]},"length"),json({},"tool_calls"),json({tool_calls:[call({id:""})]})]){
   const h=client(response),emitted:string[]=[];await expect(h.c.chat({...request,onText:t=>emitted.push(t)})).rejects.toThrow();expect(emitted).toEqual([]);
  }
 });
 it("refuses multiple streamed indexes, invalid fragments and truncated streams",async()=>{
  for(const events of [[chunk({tool_calls:[{index:0,id:"a",function:{name:"file_ops",arguments:"{}"}},{index:1,id:"b",function:{name:"file_ops",arguments:"{}"}}]}),"[DONE]"],[chunk({tool_calls:[{index:0,id:"a",function:{name:"file_ops",arguments:1}}]}),"[DONE]"],[chunk({tool_calls:[{index:0,id:"a",function:{name:"file_ops",arguments:'{"input":"x"}'}}]})]]){
   const h=client(sse(events));await expect(h.c.chat({...request,onText:()=>{}})).rejects.toThrow();
  }
 });
 it("treats plain content as an answer, never as executable TOOL text",async()=>{
  const content="TOOL: file_ops\nINPUT: malicious plain content";const h=client(json({content},"stop")),registry=new ToolRegistry();let effects=0;registry.register({name:"file_ops",description:"files",run:()=>{effects++;return{ok:true,output:"no"};}});
  const r=await new AgentLoop(h.c,registry,{model:"fixture-model"}).run("Read files");expect(effects).toBe(0);expect(r.answer).toBe(content);
 });
 it("preserves plain chat and legacy local transport unless explicitly configured",async()=>{
  for(const options of [{name:"local"},{name:"custom"},{name:"openrouter",structuredTools:false}]){const h=client(json({content:"TOOL: file_ops\nINPUT: legacy"},"stop"),options);expect((await h.c.chat(request)).text).toContain("TOOL:");expect(h.bodies[0].tools).toBeUndefined();}
  const plain=client(json({content:"ordinary chat"},"stop"));expect((await plain.c.chat({...request,tools:undefined})).text).toBe("ordinary chat");expect(plain.bodies[0].tools).toBeUndefined();
  const custom=client(json({tool_calls:[call()]}),{name:"custom",structuredTools:true});expect((await custom.c.chat(request)).text).toMatch(/^TOOL:/);expect(custom.bodies[0].tools).toBeDefined();
 });
 it("aliases long Hades identifiers and restores their actual name",async()=>{
  const name="mcp_"+"server".repeat(15);let h:ReturnType<typeof client>;h=client(()=>{const alias=h.bodies[0].tools[0].function.name;return json({tool_calls:[call({function:{name:alias,arguments:'{"input":"{}"}'}})]});});
  expect((await h.c.chat({...request,tools:[{name,description:"Long MCP name"}]})).text).toBe(`TOOL: ${name}\nINPUT: {}`);expect(h.bodies[0].tools[0].function.name.length).toBeLessThanOrEqual(64);
 });
 it("cancels a native stream before an incomplete tool can be returned",async()=>{
  const abort=new AbortController();let cancel=false;const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(chunk({tool_calls:[{index:0,id:"a",function:{name:"file_ops",arguments:'{"input":'}}]}))+'\n\n'));},cancel(){cancel=true;}});
  const h=client(new Response(stream,{headers:{"content-type":"text/event-stream"}}));const pending=h.c.chat({...request,onText:()=>{},signal:abort.signal});const check=expect(pending).rejects.toThrow();await new Promise(r=>setTimeout(r,10));abort.abort();await check;expect(cancel).toBe(true);
 });
 it("exports status-bearing definitive HTTP failures with bounded retry delays and redaction",async()=>{
  for(const status of [401,403,429,500]){const h=client(new Response("key-test-private Bearer another-secret",{status,headers:{"retry-after":"9999"}}),{apiKey:"key-test-private"});try{await h.c.chat(request);throw Error("Expected rejection");}catch(error){expect(error).toBeInstanceOf(HttpProviderError);expect(error).toMatchObject({status,retryAfterMs:300000});expect(String(error)).not.toContain("key-test-private");expect(String(error)).not.toContain("another-secret");}}
 });
 it("never classifies a partial-stream error as a retryable HTTP rejection",async()=>{
  const h=client(sse([chunk({content:"partial"}),{error:{message:"429 after inference started"}}]));try{await h.c.chat({...request,onText:()=>{}});throw Error("Expected rejection");}catch(error){expect(error).not.toBeInstanceOf(HttpProviderError);expect(String(error)).toContain("429");}
 });
});
