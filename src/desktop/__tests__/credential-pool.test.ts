import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { CredentialPool } from "../core/credential-pool";
import { HttpModelClient, HttpProviderError, type ChatRequest, type ChatResponse, type ModelClient } from "../../hades/models/client";
const pools:CredentialPool[]=[],dirs:string[]=[],servers:Server[]=[];
afterEach(async()=>{for(const p of pools.splice(0))p.close();for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const request:ChatRequest={model:"fixture",messages:[{role:"user",content:"Hello"}]};
const result:ChatResponse={text:"done",tokensIn:1,tokensOut:1,usd:0,model:"fixture",provider:"fixture"};
const gate=<T>()=>{let resolve!:(v:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"hades-credential-test-"));dirs.push(dir);const path=join(dir,"pool.sqlite"),secrets=new Map<string,string>();let now=10000;
 const reopen=()=>{const p=new CredentialPool(path,account=>secrets.get(account),()=>now);pools.push(p);return p;};const pool=reopen();
 const add=(name:string,profile="one",provider="openrouter",enabled=true)=>{const e=pool.add(profile,provider,name);secrets.set(e.account,`fixture-private-key-${name}`);if(enabled)pool.update(e.id,profile,true);return e;};
 return{dir,path,secrets,pool,reopen,add,setNow:(value:number)=>{now=value;}};
}
const success=():ModelClient=>({chat:async()=>result});
describe("CredentialPool real SQLite and bounded request rotation",()=>{
 it("stores private metadata only, masks keys, and rejects malformed authority and labels",()=>{
  const f=fixture(),entry=f.add("primary"),secret=f.secrets.get(entry.account)!;
  const listed=f.pool.list("one");expect(listed[0]).toMatchObject({configured:true,status:"ready",masked:"••••mary"});expect(JSON.stringify(listed)).not.toContain(secret);
  for(const path of [f.path,`${f.path}-wal`,`${f.path}-shm`]){expect(statSync(path).mode&0o777).toBe(0o600);expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);}
  for(const call of [()=>f.pool.add("bad:profile","openai","label"),()=>f.pool.add("one",["openai"],"label"),()=>f.pool.add("one","codex","label"),()=>f.pool.add("one","openai","line\nbreak"),()=>f.pool.add("one","openai"," "),()=>f.pool.list("../other")])expect(call).toThrow();
 });
 it("isolates profile/provider candidates and rejects cross-profile mutations",async()=>{
  const f=fixture(),own=f.add("own"),other=f.add("other","two"),anthropic=f.add("anthropic","one","anthropic");const used:string[]=[];
  await f.pool.client("one","openrouter",key=>({chat:async()=>{used.push(key);return result;}}),()=>{throw Error("unexpected fallback");}).chat(request);
  expect(used).toEqual([f.secrets.get(own.account)]);expect(used).not.toContain(f.secrets.get(other.account));expect(used).not.toContain(f.secrets.get(anthropic.account));
  expect(()=>f.pool.remove(own.id,"two")).toThrow("another profile");expect(()=>f.pool.update(own.id,"two",false)).toThrow("another profile");
 });
 it("rotates only definitive401/403/429 failures and caps one request at three attempts",async()=>{
  const f=fixture();for(const name of ["a","b","c","d"])f.add(name);const used:string[]=[];let index=0;
  const client=f.pool.client("one","openrouter",key=>({chat:async()=>{used.push(key);throw new HttpProviderError("definitive rejection",[401,403,429,500][index++]);}}),success);
  await expect(client.chat(request)).rejects.toMatchObject({status:429});expect(used).toHaveLength(3);expect(f.pool.list("one").map(e=>e.status)).toEqual(["rejected","rejected","cooling_down","ready"]);
 });
 it("does not rotate timeout, ambiguous text, stream failure,500 or abort outcomes",async()=>{
  for(const error of [new Error("timeout"),new Error("401 rejected in arbitrary text"),new Error("partial stream429"),new HttpProviderError("server failed",500)]){
   const f=fixture();f.add("a");f.add("b");let calls=0;const c=f.pool.client("one","openrouter",()=>({chat:async()=>{calls++;throw error;}}),success);await expect(c.chat(request)).rejects.toBe(error);expect(calls).toBe(1);expect(f.pool.list("one").every(e=>e.status==="ready")).toBe(true);
  }
  const f=fixture();f.add("a");f.add("b");const abort=new AbortController();let calls=0;const c=f.pool.client("one","openrouter",()=>({chat:async()=>{calls++;abort.abort();throw new HttpProviderError("rejected",401);}}),success);await expect(c.chat({...request,signal:abort.signal})).rejects.toThrow();expect(calls).toBe(1);
 });
 it("respects rate-limit cooldown and makes a key eligible again at expiry",async()=>{
  const f=fixture();f.add("a");let calls=0;const c=f.pool.client("one","openrouter",()=>({chat:async()=>{if(++calls===1)throw new HttpProviderError("limit",429,2000);return result;}}),success);
  await expect(c.chat(request)).rejects.toMatchObject({status:429});f.setNow(11999);await expect(c.chat(request)).rejects.toThrow("No ready");expect(calls).toBe(1);f.setNow(12000);expect(await c.chat(request)).toEqual(result);expect(calls).toBe(2);
 });
 it("rechecks concurrent disable/removal before trying another candidate",async()=>{
  const f=fixture();f.add("a");const b=f.add("b"),c=f.add("c"),pending=gate<ChatResponse>();let calls=0;
  const client=f.pool.client("one","openrouter",()=>({chat:async()=>{calls++;return pending.promise;}}),success);const run=client.chat(request),check=expect(run).rejects.toMatchObject({status:401});
  f.pool.remove(b.id,"one");f.pool.update(c.id,"one",false);pending.reject(new HttpProviderError("bad",401));await check;expect(calls).toBe(1);expect(f.pool.list("one")).toHaveLength(2);expect(f.pool.list("one")[1].status).toBe("disabled");
 });
 it("does not reject a replacement key because an old request later receives401",async()=>{
  const f=fixture(),a=f.add("a");f.add("b");const pending=gate<ChatResponse>();let calls=0;const c=f.pool.client("one","openrouter",()=>({chat:async()=>++calls===1?pending.promise:result}),success);
  const run=c.chat(request);f.secrets.set(a.account,"fixture-new-valid-key");f.pool.update(a.id,"one",true);pending.reject(new HttpProviderError("old key invalid",401));await run;expect(f.pool.list("one")[0].status).toBe("ready");
 });
 it("rechecks cooldown changed by a concurrent request",async()=>{
  const f=fixture();f.add("a");f.add("b");f.add("c");const pending=gate<ChatResponse>(),used:string[]=[];
  const c=f.pool.client("one","openrouter",key=>({chat:async()=>{used.push(key.at(-1)!);if(key.endsWith("a"))return pending.promise;if(key.endsWith("b"))throw new HttpProviderError("rate limited",429);return result;}}),success);
  const first=c.chat(request);await c.chat(request);pending.reject(new HttpProviderError("bad",401));await first;expect(used).toEqual(["a","b","c","c"]);
 });
 it("closes in-flight clients, rejects late success and never advances after close",async()=>{
  const f=fixture();f.add("a");f.add("b");const pending=gate<ChatResponse>();let calls=0,closed=0;const c=f.pool.client("one","openrouter",()=>({chat:async()=>{calls++;return pending.promise;},close:()=>{closed++;}}),success);
  const run=c.chat(request),check=expect(run).rejects.toThrow("pool is closed");f.pool.close();await check;pending.resolve(result);expect(calls).toBe(1);expect(closed).toBe(1);await expect(c.chat(request)).rejects.toThrow("pool is closed");
 });
 it("fails closed after restart when enabled metadata has no Keychain material",async()=>{
  const f=fixture();f.add("a");f.pool.close();f.secrets.clear();const reopened=f.reopen();let fallback=0;
  expect(reopened.list("one")[0]).toMatchObject({enabled:true,configured:false,status:"missing"});await expect(reopened.client("one","openrouter",()=>{throw Error("no key");},()=>{fallback++;return success();}).chat(request)).rejects.toThrow("No ready");expect(fallback).toBe(0);
 });
 it("uses and closes the normal fallback only when the pool is explicitly disabled",async()=>{
  const f=fixture();f.add("a","one","openrouter",false);let closed=0;const c=f.pool.client("one","openrouter",()=>{throw Error("unexpected pool");},()=>({chat:async()=>result,close:()=>{closed++;throw Error("cleanup");}}));expect(await c.chat(request)).toEqual(result);expect(closed).toBe(1);
 });
 it("rotates across actual HTTP401 then success using HttpModelClient",async()=>{
  const seen:string[]=[];const server=createServer((req,res)=>{seen.push(String(req.headers.authorization));req.resume();if(seen.length===1){res.writeHead(401,{"content-type":"application/json"});res.end('{"error":"invalid key"}');}else{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({choices:[{message:{content:"HTTP verified"},finish_reason:"stop"}],usage:{prompt_tokens:2,completion_tokens:2}}));}});servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address();if(!address||typeof address==="string")throw Error("No server address");
  const f=fixture(),a=f.add("a"),b=f.add("b");const c=f.pool.client("one","openrouter",key=>new HttpModelClient({name:"openrouter",kind:"openai",baseUrl:`http://127.0.0.1:${address.port}/v1`,models:["fixture"],apiKey:key}),()=>{throw Error("unexpected fallback");});
  expect((await c.chat(request)).text).toBe("HTTP verified");expect(seen).toEqual([`Bearer ${f.secrets.get(a.account)}`,`Bearer ${f.secrets.get(b.account)}`]);expect(f.pool.list("one")[0].status).toBe("rejected");
 });
 it("caps each provider pool and requires a saved secret before enabling",()=>{
  const f=fixture();const missing=f.pool.add("one","openai","missing");expect(()=>f.pool.update(missing.id,"one",true)).toThrow("Keychain");for(let i=0;i<8;i++)f.add(`key${i}`);expect(()=>f.add("overflow")).toThrow("limit");
 });
});
