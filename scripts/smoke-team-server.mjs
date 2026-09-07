/** Exercise the built, standalone team server without any real team credentials. */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const entry = resolve("dist/desktop/team-server.js"), dir = mkdtempSync(join(tmpdir(), "hades-team-smoke-"));
let child;
const run = args => execFileSync(process.execPath, [entry, ...args, "--data-dir", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const endpoint = `http://127.0.0.1:${port}`;
async function start() {
  child = spawn(process.execPath, [entry, "serve", "--data-dir", dir, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Team service startup timed out")), 10_000); child.once("error", reject); child.once("exit", () => reject(new Error("Team service exited before listening"))); child.stdout.once("data", () => { clearTimeout(timer); resolve(); }); });
}
async function stop() { if (!child || child.exitCode !== null) return; const exit = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exit; child = undefined; }
async function api(path, token, body) { const response = await fetch(endpoint + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200); return response.json(); }
try {
  run(["init", "--name", "Fixture team", "--owner", "Fixture owner"]);
  assert.equal(statSync(join(dir, "owner.json")).mode & 0o777, 0o600);
  const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")).token;
  const invitation = JSON.parse(run(["invite"])); await start();
  const member = await api("/join", "", { invite: invitation.invite, name: "Fixture member" });
  const team = await api("/team", member.token), channel = team.channels[0].id;
  const body = { channel, content: "Persistent team smoke", requestId: "one" };
  const sent = await api("/messages", member.token, body);
  assert.equal((await api("/messages", member.token, body)).id, sent.id);
  await stop(); await start();
  assert.equal((await api("/team", owner)).id, team.id);
  assert.equal((await api(`/messages?channel=${channel}`, member.token)).length, 1);
  console.log(JSON.stringify({ standaloneTeamServer: "passed", twoMembers: "passed", deduplication: "passed", restartPersistence: "passed", shutdown: "SIGTERM passed" }));
} finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
