import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelAccessStore, type ChannelIdentity } from "../core/channel-access";
import { SlackBot } from "../core/slack-bot";
const dirs: string[] = [], cleanups: (() => void)[] = [];
afterEach(() => { cleanups.reverse().forEach(f => f()); cleanups.length = 0; dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0; });
const identity: ChannelIdentity = { transport: "slack", account: "T1", channel: "C1", user: "U2", profile: "default" };
function fixture() { const dir = mkdtempSync(join(tmpdir(), "hades-access-")); dirs.push(dir); let now = Date.now(); const store = new ChannelAccessStore(join(dir, "access.sqlite"), () => {}, () => now); cleanups.push(() => store.close()); return { store, dir, advance: () => now += 86_400_001 }; }
class Socket extends EventTarget { readyState = 1; send() {} close() {} message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); } }
describe("Authenticated native channel access", () => {
  it("binds approval to account, channel, user and profile and retains revocation", () => {
    const { store } = fixture(); expect(store.authorize(identity, false)).toBe(false); const row = store.list("default")[0];
    expect(() => store.approve(row.id, "other")).toThrow(); store.approve(row.id, "default"); expect(store.authorize(identity, false)).toBe(true);
    for (const change of [{ account: "T2" }, { channel: "C2" }, { user: "U3" }, { profile: "other" }]) expect(store.authorize({ ...identity, ...change }, false)).toBe(false);
    store.revoke(row.id, "default"); expect(store.authorize(identity, true)).toBe(false); expect(() => store.approve(row.id, "default")).toThrow();
    store.reset(row.id, "default"); store.authorize({ ...identity, user: "U9" }, false); expect(store.authorize(identity, true)).toBe(false);
  });
  it("expires pending approval and does not preserve a removed configuration grant", () => {
    const { store, advance } = fixture(); expect(store.authorize(identity, true)).toBe(true); expect(store.authorize(identity, false)).toBe(false);
    const row = store.list("default")[0]; advance(); expect(() => store.approve(row.id, "default")).toThrow("fresh");
    store.authorize(identity, false); expect(store.list("default")[0].id).not.toBe(row.id);
  });
  it("records pending requests only after authenticated Slack validation; old delivery never replays", async () => {
    const { store, dir } = fixture(), socket = new Socket(), execute = vi.fn(async () => "done"), calls: string[] = [];
    const fetcher = vi.fn(async (url: any) => { const method = String(url).split("/").at(-1)!; calls.push(method); return new Response(JSON.stringify({ ok: true, ...({ "auth.test": { team_id: "T1", user_id: "UBOT" }, "apps.connections.open": { url: "wss://wss-primary.slack.com/link" }, "chat.postMessage": { ts: "12.1" } } as any)[method] })); }) as unknown as typeof fetch;
    const bot = new SlackBot(dir, execute, () => {}, fetcher, () => socket, store); cleanups.push(() => bot.close()); bot.credentials("xoxb-fixture", "xapp-fixture"); bot.configure({ profile: "default", root: dir, channels: ["C1"], users: ["U1"] });
    expect(await bot.testConnection()).toEqual({ account: "T1", bot: "UBOT" }); expect(bot.status().connected).toBe(false);
    await bot.connect(); socket.message({ type: "hello" });
    const event = (id: string, team = "T1") => ({ type: "events_api", payload: { type: "event_callback", team_id: team, event_id: id, event: { type: "app_mention", channel: "C1", user: "U2", text: "<@UBOT> task", ts: "1.2" } } });
    socket.message(event("spoof", "T2")); expect(store.list("default")).toHaveLength(0);
    socket.message(event("old")); expect(store.list("default")).toHaveLength(1); expect(bot.jobs()).toHaveLength(0); expect(calls).not.toContain("chat.postMessage");
    store.approve(store.list("default")[0].id, "default"); socket.message(event("old")); expect(bot.jobs()).toHaveLength(0);
    socket.message(event("fresh")); await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1)); await vi.waitFor(() => expect(bot.jobs()[0].status).toBe("sent"));
  });
  it("rechecks revoked access before draining a previously queued job", async () => {
    const { store, dir } = fixture(), socket = new Socket(), execute = vi.fn(async () => "done"), calls: string[] = [];
    const fetcher = vi.fn(async (url: any) => { const method = String(url).split("/").at(-1)!; calls.push(method); return new Response(JSON.stringify({ ok: true, ...({ "auth.test": { team_id: "T1", user_id: "UBOT" }, "apps.connections.open": { url: "wss://wss-primary.slack.com/link" } } as any)[method] })); }) as unknown as typeof fetch;
    const bot = new SlackBot(dir, execute, () => {}, fetcher, () => socket, store); cleanups.push(() => bot.close()); bot.credentials("xoxb-fixture", "xapp-fixture"); bot.configure({ profile: "default", root: dir, channels: ["C1"], users: ["U2"] }); await bot.connect();
    socket.message({ type: "events_api", payload: { type: "event_callback", team_id: "T1", event_id: "queued", event: { type: "app_mention", channel: "C1", user: "U2", text: "<@UBOT> task", ts: "1.2" } } });
    expect(bot.jobs()[0].status).toBe("queued"); store.revoke(store.list("default")[0].id, "default"); socket.message({ type: "hello" });
    await vi.waitFor(() => expect(bot.jobs()[0].status).toBe("failed")); expect(execute).not.toHaveBeenCalled(); expect(calls).not.toContain("chat.postMessage");
  });

});
