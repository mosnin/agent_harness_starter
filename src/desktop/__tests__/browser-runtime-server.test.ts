import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { HelmHandoffStore } from "../core/helm-handoff.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserRuntimeServer, type BrowserRuntimeDescriptor } from "../core/browser-runtime-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(handler?: (directory: string) => (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "hades-pair-test-"));
  const dispatch = vi.fn(handler?.(directory) ?? (async (_method: string, _params: Record<string, unknown>) => ({ providerReady: true })));
  const server = new BrowserRuntimeServer(directory, dispatch);
  await server.start();
  const descriptor: BrowserRuntimeDescriptor = JSON.parse(await readFile(server.path, "utf8"));
  cleanups.push(async () => { server.close(); await rm(directory, { recursive: true, force: true }); });
  const call = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(descriptor.endpoint + path, {
    method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { server, dispatch, descriptor, call };
}
describe("same-user browser runtime discovery", () => {
  it("writes private discovery and exposes only the allowlisted operations", async () => {
    const f = await fixture();
    expect((await stat(f.server.path)).mode & 0o777).toBe(0o600);
    expect((await f.call("/readiness", {})).status).toBe(200);
    expect(f.dispatch).toHaveBeenCalledWith("browser.readiness", {});
    expect((await f.call("/dispatch", { method: "shell.exec" })).status).toBe(404);
  });
  it("rejects web origins and missing authentication before dispatch", async () => {
    const f = await fixture();
    expect((await f.call("/readiness", {}, { origin: "https://example.com" })).status).toBe(403);
    expect((await f.call("/readiness", {}, { authorization: "" })).status).toBe(403);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("pairs only a loopback browser endpoint and drops unrelated parameters", async () => {
    const f = await fixture(); const token = "a".repeat(64);
    expect((await f.call("/pair", { endpoint: "ws://example.com:8787", token })).status).toBe(400);
    expect((await f.call("/pair", { endpoint: "ws://127.0.0.1:8787", token, method: "shell.exec" })).status).toBe(200);
    expect(f.dispatch).toHaveBeenCalledWith("browser.pair", { endpoint: "ws://127.0.0.1:8787/", token });
  });
  it("bounds incoming bodies", async () => {
    const f = await fixture();
    expect((await f.call("/pair", { text: "x".repeat(20_000) })).status).toBe(413);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});

it("preserves UTF-8 across HTTP chunks and admits duplicate Helm drafts without task dispatch", async () => {
  let store: HelmHandoffStore;
  const f=await fixture(directory=>{
    store=new HelmHandoffStore(directory);
    return async (method,body)=>{
      if(method!=="browser.helmDraft") throw new Error("Unexpected runtime operation");
      const draft=store.receive(body);return {id:draft.id,status:draft.status};
    };
  });
  const body={requestId:randomUUID(),prompt:"Build 🧭 navigation",notebook:{id:"n",workspaceId:"s",title:"日本語 research",body:"é 🧭 evidence",sources:[]}};
  const encoded=Buffer.from(JSON.stringify(body)),split=encoded.indexOf(Buffer.from("🧭"))+1;
  const result=await new Promise<{status:number;body:string}>((resolve,reject)=>{
    const req=request(f.descriptor.endpoint+"/helm-draft",{method:"POST",headers:{authorization:`Bearer ${f.descriptor.token}`,"content-type":"application/json"}},res=>{
      let response="";res.setEncoding("utf8");res.on("data",chunk=>response+=chunk);res.on("end",()=>resolve({status:res.statusCode!,body:response}));res.on("error",reject);
    });
    req.on("error",reject);req.write(encoded.subarray(0,split));setTimeout(()=>req.end(encoded.subarray(split)),20);
  });
  expect(result.status).toBe(200);expect(JSON.parse(result.body)).toEqual({id:body.requestId,status:"draft"});
  expect(f.dispatch).toHaveBeenCalledWith("browser.helmDraft",body);
  expect(await (await f.call("/helm-draft",body)).json()).toEqual(JSON.parse(result.body));
  expect(store!.list()).toHaveLength(1);expect(store!.list()[0].notebook.body).toBe(body.notebook.body);
  expect(f.dispatch.mock.calls.every(([method])=>method==="browser.helmDraft")).toBe(true);
  expect(store!.list()[0].status).toBe("draft");
});
it("rejects oversized Helm drafts by UTF-8 bytes before dispatch",async()=>{
  const f=await fixture();
  const body={body:"🧭".repeat(32769)};
  expect(JSON.stringify(body).length).toBeLessThan(131072);
  expect((await f.call("/helm-draft",body)).status).toBe(413);expect(f.dispatch).not.toHaveBeenCalled();
});
it("requires the exact authenticated native Helm route and rejects browser origins",async()=>{
  const f=await fixture();
  for(const headers of ([{authorization:""},{authorization:"Bearer wrong"},{origin:"https://example.test"}] as Array<Record<string,string>>)) {
    expect((await f.call("/helm-draft",{},headers)).status).toBe(403);
  }
  expect((await f.call("/helm-draft?method=helm.start",{})).status).toBe(404);
  expect((await f.call("/helm.start",{})).status).toBe(404);
  expect((await fetch(f.descriptor.endpoint+"/helm-draft",{headers:{authorization:`Bearer ${f.descriptor.token}`}})).status).toBe(404);
  expect(f.dispatch).not.toHaveBeenCalled();
});
it("returns a safe failed draft acknowledgement without exposing dispatch diagnostics",async()=>{
  const f=await fixture(()=>async()=>{throw new Error("credential-secret");});
  const response=await f.call("/helm-draft",{});expect(response.status).toBe(400);
  const body=await response.text();expect(body).toContain("no coding task was started");expect(body).not.toContain("credential-secret");
});
