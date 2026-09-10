import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackBot, type SlackJob } from "../core/slack-bot";
class FakeSocket extends EventTarget {
  readyState = 1; sent: string[] = [];
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
}
const dirs: string[] = [], bots: SlackBot[] = [];
afterEach(() => { for (const b of bots) b.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); bots.length = dirs.length = 0; vi.useRealTimers(); });
function fixture(execute = vi.fn(async (_j: SlackJob, bind: (s: string) => void) => { bind("session-one"); return "Completed"; }), dir = mkdtempSync(join(tmpdir(), "hades-slack-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const sockets: FakeSocket[] = [], calls: Array<{ method: string; body: any }> = [];
  let updateFails = false, team = "T1";
  const fetcher = vi.fn(async (url: any, init: any) => {
    const method = String(url).split("/").at(-1)!; calls.push({ method, body: JSON.parse(init.body) });
    if (method === "chat.update" && updateFails) throw new Error("Connection lost");
    return new Response(JSON.stringify({ ok: true, ...({ "auth.test": { team_id: team, user_id: "UBOT" }, "apps.connections.open": { url: "wss://wss-primary.slack.com/link" }, "chat.postMessage": { ts: "42.0001" } } as any)[method] }));
  }) as unknown as typeof fetch;
  const bot = new SlackBot(dir, execute, () => {}, fetcher, () => { const s = new FakeSocket(); sockets.push(s); return s; }); bots.push(bot);
  bot.credentials("xoxb-test-secret", "xapp-test-secret");
  const config = { profile: "p1", root: "/project", channels: ["C1"], users: ["U1"] };
  if (!bot.status().config) bot.configure(config);
  return { bot, dir, sockets, calls, execute, config, failUpdate: (v: boolean) => updateFails = v, team: (v: string) => team = v,
    async connect() { await bot.connect(); sockets.at(-1)!.message({ type: "hello" }); } };
}
const payload = (id = "E1", event: object = {}, team = "T1") => ({ type: "event_callback", team_id: team, event_id: id, event: { type: "app_mention", user: "U1", channel: "C1", text: "<@UBOT> read README", ts: "123.001", ...event } });
describe("Slack durable Socket Mode bridge (local protocol fixtures)", () => {
  it("persists before ack, deduplicates mentions and updates the same threaded progress message", async () => {
    const f = fixture(); await f.connect();
    const s = f.sockets[0]; const envelope = { type: "events_api", envelope_id: "envelope-one", payload: payload() };
    s.message(envelope); s.message(envelope);
    expect(f.bot.jobs()).toHaveLength(1); expect(s.sent).toEqual([JSON.stringify({ envelope_id: "envelope-one" }), JSON.stringify({ envelope_id: "envelope-one" })]);
    await vi.waitFor(() => expect(f.bot.jobs()[0].status).toBe("sent"));
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.calls.find(c => c.method === "chat.postMessage")?.body).toMatchObject({ channel: "C1", thread_ts: "123.001" });
    expect(f.calls.find(c => c.method === "chat.update")?.body).toMatchObject({ channel: "C1", ts: "42.0001", text: "Completed" });
    expect(readFileSync(join(f.dir, "slack.sqlite")).toString()).not.toContain("test-secret");
    expect(JSON.stringify(f.bot.status())).not.toContain("test-secret");
  });
  it("rejects other tenants, unauthorized channels/members, bot loops, unmentioned messages and malformed events", async () => {
    const f = fixture(); await f.connect();
    for (const p of [payload("E1", {}, "T2"), payload("E2", { channel: "C2" }), payload("E3", { user: "U2" }), payload("E4", { bot_id: "B1" }), payload("E5", { type: "message" }), payload("E6", { text: "plain" }), payload("E7", { thread_ts: {} }), payload("E8", { subtype: "message_changed" })]) f.bot.ingest(p);
    expect(f.bot.jobs()).toEqual([]); expect(f.execute).not.toHaveBeenCalled();
  });
  it("retains thread conversation ownership and serializes concurrent replies", async () => {
    const f = fixture(); await f.connect();
    f.bot.ingest(payload()); f.bot.ingest(payload("E2", { ts: "124.001", thread_ts: "123.001" }));
    await vi.waitFor(() => expect(f.bot.jobs().every(j => j.status === "sent")).toBe(true));
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.execute.mock.calls[1][0]).toMatchObject({ session: "session-one", root: "/project", profile: "p1" });
  });
  it("recovers queued events after restart, preserves dedupe and retries delivery without repeating inference", async () => {
    const f = fixture(); await f.bot.connect(); // no hello yet, inbox can persist while offline
    f.bot.ingest(payload()); expect(f.bot.jobs()[0].status).toBe("queued"); f.bot.close();
    const next = fixture(undefined, f.dir); next.failUpdate(true); await next.connect();
    await vi.waitFor(() => expect(next.bot.jobs()[0].status).toBe("ready"));
    next.bot.ingest(payload()); expect(next.bot.jobs()).toHaveLength(1);
    next.failUpdate(false); await next.bot.publish("T1-E1");
    expect(next.bot.jobs()[0].status).toBe("sent"); expect(next.execute).toHaveBeenCalledTimes(1);
    expect(next.calls.filter(c => c.method === "chat.postMessage")).toHaveLength(1);
    expect(next.calls.filter(c => c.method === "chat.update")).toHaveLength(2);
  });
  it("does not publish an old reply into another workspace or report failed inference as sent", async () => {
    const f = fixture(); f.failUpdate(true); await f.connect(); f.bot.ingest(payload());
    await vi.waitFor(() => expect(f.bot.jobs()[0].status).toBe("ready")); f.bot.disconnect(); f.team("T2"); await f.connect();
    await expect(f.bot.publish("T1-E1")).rejects.toThrow("original Slack workspace");
    const bad = fixture(vi.fn(async () => { throw new Error("Approval declined"); })); await bad.connect(); bad.bot.ingest(payload());
    await vi.waitFor(() => expect(bad.bot.jobs()[0].status).toBe("failed"));
    expect(bad.calls.find(c => c.method === "chat.update")?.body.text).toContain("could not complete");
  });
  it("reconnects after socket close and stops retrying when disconnected", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.connect(); f.sockets[0].close();
    expect(f.bot.status().connection).toBe("Reconnecting"); await vi.advanceTimersByTimeAsync(1000);
    expect(f.sockets).toHaveLength(2); f.sockets[1].message({ type: "hello" }); expect(f.bot.status().connected).toBe(true);
    f.bot.disconnect(); await vi.advanceTimersByTimeAsync(60_000); expect(f.sockets).toHaveLength(2);
  });
});
