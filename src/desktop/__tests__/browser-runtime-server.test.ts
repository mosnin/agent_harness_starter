import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserRuntimeServer, type BrowserRuntimeDescriptor } from "../core/browser-runtime-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hades-pair-test-"));
  const dispatch = vi.fn(async () => ({ providerReady: true }));
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
  it("writes private discovery and exposes only the readiness operation", async () => {
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
