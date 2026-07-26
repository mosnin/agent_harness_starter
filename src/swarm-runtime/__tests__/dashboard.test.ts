import { describe, it, expect, afterEach } from "vitest";
import { DASHBOARD_HTML } from "../server/dashboard";
import { buildSwarm } from "../server/build-swarm";
import { SwarmServer } from "../server/swarm-server";

describe("dashboard HTML", () => {
  it("includes the Phase D panels", () => {
    expect(DASHBOARD_HTML).toContain("Task Graph (DAG)");
    expect(DASHBOARD_HTML).toContain("Evidence &amp; Provenance");
    expect(DASHBOARD_HTML).toContain('id="dag"');
    expect(DASHBOARD_HTML).toContain('id="prov"');
    // balanced-ish: a well-formed single document
    expect(DASHBOARD_HTML.startsWith("<!doctype html>")).toBe(true);
    expect(DASHBOARD_HTML.trim().endsWith("</html>")).toBe(true);
  });
});

describe("dashboard is served", () => {
  let server: SwarmServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("serves the dashboard at /", async () => {
    const swarm = await buildSwarm({ mode: "inline", capabilities: ["research"], poolSize: 1 });
    const port = 39240;
    server = new SwarmServer(swarm, { port });
    await server.listen();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("HERMES·SWARM");
  });
});
