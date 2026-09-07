import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexProvider } from "../models/codex-provider";
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
  out({id:900,method:'item/commandExecution/requestApproval',params:{threadId}});
  out({method:'item/agentMessage/delta',params:{threadId,delta:'ANSWER: hello'}});
  out({method:'thread/tokenUsage/updated',params:{threadId,tokenUsage:{total:{inputTokens:12,outputTokens:3}}}});
  out({method:'turn/completed',params:{threadId,turn:process.env.FIXTURE_MODE==='failed'?{...turn,status:'failed',error:{message:'provider failed'}}:turn}});
  return reply({turn});
 }
 default: return reply({});
}});
`, { mode: 0o700 });
  const provider = new CodexProvider(join(dir, "home"), () => {}, { ...process.env, HADES_CODEX_BIN: binary, FIXTURE_LOG: log, FIXTURE_MODE: mode, OPENAI_API_KEY: "not-for-subscription" }); providers.push(provider);
  return { provider, log, dir };
}
const request = { model: "fixture-model", messages: [{ role: "user" as const, content: "hello" }] };
describe("Codex official app-server adapter (local protocol fixture)", () => {
  it("handles early streamed notifications, usage and refused native tool requests without exposing API credentials", async () => {
    const f = fixture(), chunks: string[] = [];
    expect(await f.provider.models()).toEqual(["fixture-model"]);
    const reply = await f.provider.chat({ ...request, onText: t => chunks.push(t) });
    expect(reply).toMatchObject({ text: "ANSWER: hello", tokensIn: 12, tokensOut: 3, costMeasured: false, provider: "codex" });
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
