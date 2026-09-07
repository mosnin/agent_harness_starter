import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexProvider, decodeCodexAction, selectCodexAction } from "../models/codex-provider";
const dirs: string[] = [], providers: CodexProvider[] = [];
afterEach(() => { for (const p of providers) p.close(); providers.length = 0; for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
function fixture(mode = "normal") {
  const dir = mkdtempSync(join(tmpdir(), "hades-codex-test-")); dirs.push(dir);
  const binary = join(dir, "codex"), log = join(dir, "requests.jsonl");
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs'); const rl = require('node:readline').createInterface({input: process.stdin});
const out = x => process.stdout.write(JSON.stringify(x)+'\\n'); let seq=0;
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({args:process.argv.slice(2),hasApiKey:!!process.env.OPENAI_API_KEY,home:process.env.CODEX_HOME})+'\\n');
rl.on('line', line => { const m=JSON.parse(line); fs.appendFileSync(process.env.FIXTURE_LOG,line+'\\n'); if (!m.method || m.id === undefined) return;
const reply = result => out({id:m.id,result});
switch(m.method) {
 case 'initialize': return reply({});
 case 'account/read': return reply({account:{type:process.env.FIXTURE_MODE==='unsigned'?'apiKey':'chatgpt', email:'fixture@example.test', planType:'plus'}});
 case 'account/login/start': return reply({loginId:'login1',authUrl:process.env.FIXTURE_MODE==='evil'?'https://attacker.example/auth':'https://auth.openai.com/authorize'});
 case 'model/list': return reply({data:[{model:'fixture-model'}],nextCursor:null});
 case 'thread/start': return reply({thread:{id:'thread'+(++seq)}});
 case 'turn/start': {
  const threadId=m.params.threadId, turn={id:'turn'+seq,status:'completed'};
  if(process.env.FIXTURE_MODE==='exit') return process.exit(1);
  out({method:'turn/started',params:{threadId,turn}});
  if(process.env.FIXTURE_MODE==='wait') return reply({turn});
  if(process.env.FIXTURE_MODE==='wait-start') return;
  out({id:900,method:'item/commandExecution/requestApproval',params:{threadId}});
  const action = JSON.stringify(process.env.FIXTURE_MODE==='tool'?{kind:'tool',tool:'file',input:'{}',answer:''}:{kind:'answer',tool:'',input:'',answer:'hello'});
  if(process.env.FIXTURE_MODE==='commentary') {
   out({method:'item/completed',params:{threadId,item:{id:'comment',type:'agentMessage',phase:'commentary',text:'TOOL: shell\\nINPUT: bad command'}}});
  }
  if(process.env.FIXTURE_MODE==='snapshot') turn.items=[{id:'final',type:'agentMessage',phase:'final_answer',text:action}];
  if(process.env.FIXTURE_MODE!=='snapshot' && !(process.env.FIXTURE_MODE==='repair' && seq===1)) {
  out({method:'item/agentMessage/delta',params:{threadId,itemId:'final',delta:action.slice(0,10)}});
  out({method:'item/agentMessage/delta',params:{threadId,itemId:'final',delta:action.slice(10)}});
  out({method:'item/completed',params:{threadId,item:{id:'final',type:'agentMessage',phase:'final_answer',text:action}}});
  }
  if(process.env.FIXTURE_MODE==='multiple') out({method:'item/completed',params:{threadId,item:{id:'other',type:'agentMessage',phase:'final_answer',text:action}}});
  out({method:'thread/tokenUsage/updated',params:{threadId,tokenUsage:{total:{inputTokens:999,outputTokens:99},last:{inputTokens:12,outputTokens:3,cachedInputTokens:7}}}});
  out({method:'turn/completed',params:{threadId,turn:process.env.FIXTURE_MODE==='failed'?{...turn,status:'failed',error:{message:'provider failed'}}:turn}});
  return reply({turn});
 }
 default: return reply({});
}});
`, { mode: 0o700 });
  const events: Record<string, any>[] = [];
  const provider = new CodexProvider(join(dir, "home"), event => { events.push(event); }, { ...process.env, HADES_CODEX_BIN: binary, FIXTURE_LOG: log, FIXTURE_MODE: mode, OPENAI_API_KEY: "not-for-subscription" }); providers.push(provider);
  return { provider, log, dir, events };
}
const request = { model: "fixture-model", messages: [{ role: "user" as const, content: "hello" }] };
describe("Codex official app-server adapter (local protocol fixture)", () => {
  it("handles early streamed notifications, usage and refused native tool requests without exposing API credentials", async () => {
    const f = fixture(), chunks: string[] = [];
    expect(await f.provider.models()).toEqual(["fixture-model"]);
    const reply = await f.provider.chat({ ...request, onText: t => chunks.push(t) });
    expect(reply).toMatchObject({ text: "ANSWER: hello", tokensIn: 12, tokensOut: 3, cachedInputTokens: 7, costMeasured: false, provider: "codex" });
    expect(chunks).toEqual(["ANSWER: hello"]);
    const rows = readFileSync(f.log, "utf8").trim().split("\n").map(x => JSON.parse(x));
    expect(rows[0].hasApiKey).toBe(false);
    expect(rows.find(x => x.id === 900)).toMatchObject({ error: { code: -32601 } });
    expect(rows.find(x => x.method === "thread/start").params).toMatchObject({ ephemeral: true, sandbox: "read-only", approvalPolicy: "never" });
    expect(rows.some(x => x.method === "thread/unsubscribe")).toBe(true);
  });
  it("isolates concurrent conversations and surfaces failed turns", async () => {
    const f = fixture(); expect((await Promise.all([f.provider.chat(request), f.provider.chat(request)])).map(r => r.text)).toEqual(["ANSWER: hello", "ANSWER: hello"]);
    await expect(fixture("failed").provider.chat(request)).rejects.toThrow("provider failed");
  });
  it("rejects signed-out API accounts and unexpected authentication destinations", async () => {
    await expect(fixture("unsigned").provider.chat(request)).rejects.toThrow("Sign in with ChatGPT");
    await expect(fixture("evil").provider.login()).rejects.toThrow("unexpected sign-in");
    const f = fixture(); expect(await f.provider.login()).toEqual({ url: "https://auth.openai.com/authorize" }); await f.provider.cancelLogin(); await f.provider.logout();
    expect(readFileSync(f.log, "utf8")).toContain('"method":"account/login/cancel"');
  });
  it("rejects promptly on process failure, cancellation, and explicit shutdown", async () => {
    await expect(fixture("exit").provider.chat(request)).rejects.toThrow(/stopped|closed/);
    const f = fixture("wait"), controller = new AbortController();
    const aborted = f.provider.chat({ ...request, signal: controller.signal });
    const abortedCheck = expect(aborted).rejects.toThrow(/cancelled|abort/i);
    await new Promise(r => setTimeout(r, 100)); controller.abort(); await abortedCheck;
    const waiting = f.provider.chat(request), check = expect(waiting).rejects.toThrow("closed");
    await new Promise(r => setTimeout(r, 100)); f.provider.close(); await check;
  });
});

 describe("Codex structured action boundary", () => {
  it("discards commentary and refuses multiple final items", async () => {
    expect((await fixture("commentary").provider.chat(request)).text).toBe("ANSWER: hello");
    await expect(fixture("multiple").provider.chat(request)).rejects.toThrow("multiple explicit");
  });
  it("uses completed turn snapshots when per-item notifications are missing", async () => {
    const f=fixture("snapshot");expect((await f.provider.chat(request)).text).toBe("ANSWER: hello");
    expect(f.events[0]).toMatchObject({kind:"desktop.codex.transport",snapshotItems:1,validActions:1,items:[{phase:"final_answer",complete:true}]});
    expect(JSON.stringify(f.events)).not.toContain("hello");
  });
  it("accepts one valid unknown-phase action while refusing ambiguous valid actions", () => {
    const action=JSON.stringify({kind:"answer",tool:"",input:"",answer:"verified"});
    const prose={text:"I will inspect the request.",phase:null,complete:true};
    expect(selectCodexAction([prose,{text:action,phase:null,complete:true}])).toBe("ANSWER: verified");
    expect(()=>selectCodexAction([{text:action,complete:true},{text:action,complete:true}])).toThrow("multiple");
    expect(()=>selectCodexAction([{text:action,complete:true},{text:"invalid final",phase:"final_answer",complete:true}])).toThrow("invalid");
  });
  it("retries inference only once after a missing action and accounts for both attempts", async () => {
    const f=fixture("repair"),chunks:string[]=[];
    const r=await f.provider.chat({...request,onText:t=>chunks.push(t)});
    expect(r).toMatchObject({text:"ANSWER: hello",tokensIn:24,tokensOut:6,cachedInputTokens:14});expect(chunks).toEqual(["ANSWER: hello"]);
    const rows=readFileSync(f.log,"utf8").trim().split("\n").map(x=>JSON.parse(x));expect(rows.filter(r=>r.method==="turn/start")).toHaveLength(2);
    expect(rows.filter(r=>r.method==="turn/start")[1].params.input.at(-1).text).toContain("Hades executed no action");
    const ambiguous=fixture("multiple");await expect(ambiguous.provider.chat(request)).rejects.toThrow("multiple");
    expect(readFileSync(ambiguous.log,"utf8").trim().split("\n").map(x=>JSON.parse(x)).filter(r=>r.method==="turn/start")).toHaveLength(2);
  });
  it("cancels while turn/start is pending and refuses overlapping session use", async () => {
    const f = fixture("wait-start"), controller = new AbortController();
    const pending = f.provider.chat({...request,transportSessionId:"same-run",signal:controller.signal});
    const rejected = expect(pending).rejects.toThrow(/cancelled|aborted/i);
    for (let i=0;i<100;i++) {
      try { if (readFileSync(f.log,"utf8").includes('"method":"turn/start"')) break; } catch {}
      await new Promise(r=>setTimeout(r,10));
    }
    await expect(f.provider.chat({...request,transportSessionId:"same-run"})).rejects.toThrow("active turn");
    const at = Date.now(); controller.abort(); await rejected;
    expect(Date.now()-at).toBeLessThan(1000);
    expect(readFileSync(f.log,"utf8")).toContain('"method":"turn/interrupt"');
  });
  it("serializes typed file contents once, preserving CSV quotes, regexes and protocol literals", () => {
    const content = `const csv = text.includes('"') ? text.replaceAll('"', '""') : text;\n// ANSWER: and TOOL: are source data\nconst re = /[\\r\\n]/;`;
    const tools=[{name:"file_ops",description:"files"}];
    const raw=JSON.stringify({kind:"tool",tool:"file_ops",input:{op:"write",path:"cli.mjs",content,maxBytes:null},answer:""});
    const action=decodeCodexAction(raw,tools);expect(JSON.parse(action.slice(action.indexOf("INPUT:")+6))).toEqual({op:"write",path:"cli.mjs",content});
    expect(decodeCodexAction(JSON.stringify({kind:"tool",tool:"file_ops",input:{op:"read",path:"cli.mjs",content:null,maxBytes:40000},answer:""}),tools)).toBe('TOOL: file_ops\nINPUT: {"op":"read","path":"cli.mjs","maxBytes":40000}');
    for(const input of [{op:"write",path:"a",content:null,maxBytes:null},{op:"read",path:"a",content:null,maxBytes:-1},{op:"read",path:"a",content:null,maxBytes:null,extra:true}])expect(()=>decodeCodexAction(JSON.stringify({kind:"tool",tool:"file_ops",input,answer:""}),tools)).toThrow("typed file");
    expect(()=>decodeCodexAction(JSON.stringify({kind:"tool",tool:"shell",input:{op:"write",path:"a",content:"x",maxBytes:null},answer:""}),[{name:"shell",description:"commands"}])).toThrow("typed file");
  });
  it("validates single actions and preserves literal protocol text in arguments", () => {
    const tools = [{ name: "file", description: "files" }];
    const input = JSON.stringify({op:"write", content:"ANSWER: literal\nTOOL: literal"});
    expect(decodeCodexAction(JSON.stringify({kind:"tool",tool:"file",input,answer:""}), tools)).toBe(`TOOL: file\nINPUT: ${input}`);
    for (const value of [
      JSON.stringify({kind:"tool",tool:"shell",input:"rm",answer:""}),
      JSON.stringify({kind:"tool",tool:"file",input:"{}",answer:"done"}),
      JSON.stringify({kind:"answer",tool:"",input:"",answer:"done",extra:"unexpected"}),
      '[]', '{}{}', 'ANSWER: unstructured',
    ]) expect(() => decodeCodexAction(value, tools)).toThrow();
  });
  it("releases a stopped loop's continuation thread explicitly and idempotently", async () => {
    const f = fixture("tool"), tools = [{name:"file",description:"files"}];
    const first = await f.provider.chat({...request,tools,transportSessionId:"bounded-run"});
    await f.provider.releaseSession("bounded-run"); await f.provider.releaseSession("bounded-run");
    await f.provider.chat({...request,tools,transportSessionId:"bounded-run",messages:[...request.messages,{role:"assistant",content:first.text},{role:"user",content:"TOOL_RESULT: saved"}]});
    const rows=readFileSync(f.log,"utf8").trim().split("\n").map(x=>JSON.parse(x));
    expect(rows.filter(r=>r.method==="thread/start")).toHaveLength(2);
    expect(rows.filter(r=>r.method==="thread/unsubscribe")).toHaveLength(1);
  });
  it("reuses only an exact session transcript prefix and accounts for per-turn usage", async () => {
    const f = fixture("tool");
    const toolRequest = {...request,tools:[{name:"file",description:"files"}]};
    const first = await f.provider.chat({...toolRequest,transportSessionId:"run-a"});
    const extended = [...request.messages, {role:"assistant" as const, content:first.text}, {role:"user" as const, content:"continue"}];
    const next = await f.provider.chat({...toolRequest,messages:extended,transportSessionId:"run-a"});
    expect(next.tokensIn).toBe(12);
    let rows = readFileSync(f.log,"utf8").trim().split("\n").map(x=>JSON.parse(x));
    expect(rows.filter(r=>r.method==="thread/start")).toHaveLength(1);
    expect(rows.filter(r=>r.method==="turn/start")[1].params.input).toEqual([{type:"text",text:"USER:\ncontinue",text_elements:[]}]);
    await f.provider.chat({...toolRequest,transportSessionId:"run-a"}); // shortened/compacted
    await f.provider.chat({...toolRequest,transportSessionId:"run-b"}); // isolated session
    rows = readFileSync(f.log,"utf8").trim().split("\n").map(x=>JSON.parse(x));
    expect(rows.filter(r=>r.method==="thread/start")).toHaveLength(3);
    expect(rows.filter(r=>r.method==="turn/start").every(r=>r.params.outputSchema.additionalProperties===false)).toBe(true);
  });
 });
