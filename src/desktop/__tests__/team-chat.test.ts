import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TeamStore } from "../team/store";
import { TeamServer } from "../team/server";
import { TeamClient, teamEndpoint } from "../team/client";
const roots: string[] = [], stores: TeamStore[] = [], servers: TeamServer[] = [], clients: TeamClient[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const c of clients) await c.close(); for (const s of servers) await s.close(); for (const s of stores) s.close(); for (const r of roots) rmSync(r, { recursive: true, force: true }); roots.length = stores.length = servers.length = clients.length = 0; });
function store() { const dir = mkdtempSync(join(tmpdir(), "hades-team-test-")); roots.push(dir); const s = new TeamStore(join(dir, "team.sqlite")); stores.push(s); return { s, dir }; }
async function server() { const { s, dir } = store(), server = new TeamServer(s); servers.push(server); const url = await server.listen(); const owner = s.create("Builders", "Alex"); return { s, dir, url, owner }; }
async function api(url: string, path: string, token = "", body?: unknown) { const response = await fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() as any }; }
describe("real team service and persistence", () => {
  it("supports two authenticated clients, retries, replies, pagination, read cursors and restart", async () => {
    const { s, dir, url, owner } = await server();
    const invite = (await api(url, "/invite", owner.token, {})).data.invite;
    const member = (await api(url, "/join", "", { invite, name: "Sam" })).data;
    const snapshot = (await api(url, "/team", member.token)).data;
    expect(snapshot.members.map((m: any) => m.name)).toEqual(["Alex", "Sam"]);
    const channel = snapshot.channels[0].id;
    const body = { channel, content: "Hello — 你好 👋", requestId: "message-1" };
    const first = await api(url, "/messages", owner.token, body);
    expect(first.status).toBe(200);
    expect((await api(url, "/messages", owner.token, body)).data).toMatchObject({ id: first.data.id, duplicate: true });
    expect((await api(url, "/messages", owner.token, { ...body, content: "different" })).status).toBe(409);
    expect((await api(url, "/team", member.token)).data.channels[0].unread).toBe(1);
    await api(url, "/messages", member.token, { channel, content: "Reply", requestId: "message-2", replyTo: first.data.id });
    const history = (await api(url, `/messages?channel=${channel}`, member.token)).data;
    expect(history.map((m: any) => m.content)).toEqual([body.content, "Reply"]);
    expect(history[1].replyTo).toBe(first.data.id);
    expect((await api(url, `/messages?channel=${channel}&before=${history[1].seq}`, member.token)).data).toHaveLength(1);
    expect((await api(url, `/messages?channel=${channel}&after=${history[1].seq}`, member.token)).data).toEqual([]);
    await api(url, "/read", member.token, { channel, seq: history.at(-1).seq });
    expect((await api(url, "/team", member.token)).data.channels[0].unread).toBe(0);
    await servers.pop()!.close(); stores.pop()!.close();
    const reopened = new TeamStore(join(dir, "team.sqlite")); stores.push(reopened);
    expect(reopened.messages(reopened.authenticate(member.token), channel)).toHaveLength(2);
    expect(readFileSync(join(dir, "team.sqlite")).includes(Buffer.from(member.token))).toBe(false);
    expect(() => reopened.create("another", "x")).toThrow("already exists");
  });
  it("enforces owner roles, one-use/expired invitations, tenant isolation and immediate revocation", async () => {
    const { s, url, owner } = await server();
    const invite = s.invite(s.authenticate(owner.token)).invite;
    const join = await api(url, "/join", "", { invite, name: "Sam" });
    expect((await api(url, "/join", "", { invite, name: "Again" })).status).toBe(403);
    expect((await api(url, "/invite", join.data.token, {})).status).toBe(403);
    expect((await api(url, "/revoke", join.data.token, { member: owner.member.id })).status).toBe(403);
    expect((await api(url, "/revoke", owner.token, { member: owner.member.id })).status).toBe(400);
    const other = await server();
    expect((await api(other.url, "/team", join.data.token)).status).toBe(401);
    const expired = s.invite(s.authenticate(owner.token)).invite;
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 25 * 3600_000);
    expect((await api(url, "/join", "", { invite: expired, name: "Late" })).status).toBe(403);
    vi.restoreAllMocks();
    await api(url, "/revoke", owner.token, { member: join.data.member.id });
    expect((await api(url, "/team", join.data.token)).status).toBe(401);
    expect((await api(url, "/messages", join.data.token, { content: "after revoke" })).status).toBe(401);
    const response = await fetch(url + "/team", { headers: { Origin: "https://untrusted.example", Authorization: `Bearer ${owner.token}` } });
    expect(response.status).toBe(403);
  });
  it("rejects forged reply targets, invalid cursors, duplicate channels and oversized messages", async () => {
    const { url, owner } = await server(); const channel = (await api(url, "/team", owner.token)).data.channels[0].id;
    expect((await api(url, "/channels", owner.token, { name: "general" })).status).toBe(409);
    expect((await api(url, "/messages", owner.token, { channel, content: "x", requestId: "a", replyTo: "missing" })).status).toBe(400);
    expect((await api(url, `/messages?channel=${channel}&after=NaN`, owner.token)).status).toBe(400);
    expect((await api(url, "/messages", owner.token, { channel, content: "x".repeat(40_001), requestId: "a" })).status).toBe(400);
    expect((await api(url, "/read", owner.token, { channel, seq: 999 })).status).toBe(400);
  });
  it("connects a remote client without persisting credentials and restores its connection after restart", async () => {
    const { s, url, owner } = await server(); const invite = s.invite(s.authenticate(owner.token)).invite;
    const dir = mkdtempSync(join(tmpdir(), "hades-team-client-")); roots.push(dir);
    const client = new TeamClient(dir); clients.push(client);
    const result = await client.join(url, invite, "Remote");
    expect((await client.status()).connected).toBe(true);
    expect(readFileSync(join(dir, "connection.json"), "utf8")).not.toContain(result.token);
    await client.close(); const restarted = new TeamClient(dir); clients.push(restarted); restarted.restore(result.token);
    expect((await restarted.status()).members).toHaveLength(2);
    expect(() => teamEndpoint("http://example.com")).toThrow("HTTPS");
    expect(() => teamEndpoint("https://user:password@example.com")).toThrow();
    expect(() => teamEndpoint("https://example.com/?token=secret")).toThrow();
  });
});
