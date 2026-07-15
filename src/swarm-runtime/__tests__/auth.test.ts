import { describe, it, expect, afterEach } from "vitest";
import { buildSwarm } from "../server/build-swarm";
import { SwarmServer } from "../server/swarm-server";
import { HttpControlPlane } from "../bus/http-control-plane";

let server: SwarmServer | undefined;
let plane: HttpControlPlane | undefined;
afterEach(async () => {
  await server?.close();
  await plane?.close();
  server = undefined;
  plane = undefined;
});

describe("dashboard API auth", () => {
  it("guards /api/* with a token but leaves the dashboard open", async () => {
    const built = await buildSwarm({ mode: "inline", capabilities: ["research"], poolSize: 1 });
    const port = 39280;
    server = new SwarmServer(built, { port, authToken: "s3cret" });
    await server.listen();
    const base = `http://127.0.0.1:${port}`;

    expect((await fetch(`${base}/`)).status).toBe(200); // dashboard open
    expect((await fetch(`${base}/api/state`)).status).toBe(401); // API guarded
    expect((await fetch(`${base}/api/state`, { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
    expect((await fetch(`${base}/api/state?token=s3cret`)).status).toBe(200); // query token for SSE
    expect((await fetch(`${base}/api/state`, { headers: { "x-swarm-token": "s3cret" } })).status).toBe(200);
    expect((await fetch(`${base}/api/state?token=wrong`)).status).toBe(401);
  });
});

describe("bus token rotation", () => {
  it("keeps the old token valid during the grace window, then revokes it", async () => {
    const port = 39281;
    plane = new HttpControlPlane({ port, authToken: "old" });
    await plane.listen();
    const base = `http://127.0.0.1:${port}`;
    const hit = (tok: string) => fetch(`${base}/healthz`, { headers: { authorization: `Bearer ${tok}` } });

    expect((await hit("old")).status).toBe(200);
    expect((await hit("new")).status).toBe(401);

    plane.rotateToken("new", 200);
    // during grace: both valid
    expect((await hit("old")).status).toBe(200);
    expect((await hit("new")).status).toBe(200);
    expect(plane.activeTokens().sort()).toEqual(["new", "old"]);

    await new Promise((r) => setTimeout(r, 260));
    // after grace: only new
    expect((await hit("old")).status).toBe(401);
    expect((await hit("new")).status).toBe(200);
    expect(plane.activeTokens()).toEqual(["new"]);
  });
});
