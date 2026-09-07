import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server, type RequestListener } from "node:http";
import { Checkpoints } from "../core/checkpoints";
import { LocalModels } from "../core/local-models";
import { parseShortcuts, parseTheme } from "../ui/preferences";
const roots: string[] = [],
  servers: Server[] = [],
  models: LocalModels[] = [];
afterEach(() => {
  models.forEach((m) => m.close());
  servers.forEach((s) => {
    s.closeAllConnections();
    s.close();
  });
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
  roots.length = servers.length = models.length = 0;
});
function checkpoint() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hades-checkpoint-")));
  roots.push(root);
  return { root, c: new Checkpoints(join(root, ".history")) };
}
describe("desktop checkpoints", () => {
  it("restores edited, newly created and deleted files with persisted restart state", () => {
    const { root, c } = checkpoint();
    const path = join(root, "note");
    writeFileSync(path, "before", { mode: 0o640 });
    const edited = c.capture(root, "note", "s");
    writeFileSync(path, "after");
    c.finish(edited);
    const restart = new Checkpoints(join(root, ".history"));
    expect(restart.list(root)[0]).toMatchObject({ ready: true, path: "note" });
    restart.restore(edited.id, root);
    expect(readFileSync(path, "utf8")).toBe("before");
    const created = c.capture(root, "new", "s");
    writeFileSync(join(root, "new"), "created");
    c.finish(created);
    c.restore(created.id, root);
    expect(existsSync(join(root, "new"))).toBe(false);
    const deleted = c.capture(root, "note", "s");
    rmSync(path);
    c.finish(deleted);
    c.restore(deleted.id, root);
    expect(readFileSync(path, "utf8")).toBe("before");
  });
  it("refuses newer edits, wrong projects, symlink swaps, double restore and interrupted mutations", () => {
    const { root, c } = checkpoint(),
      path = join(root, "note");
    writeFileSync(path, "before");
    const edit = c.capture(root, "note", "s");
    writeFileSync(path, "after");
    c.finish(edit);
    writeFileSync(path, "mine");
    expect(() => c.restore(edit.id, root)).toThrow("File changed");
    expect(readFileSync(path, "utf8")).toBe("mine");
    expect(() => c.restore(edit.id, tmpdir())).toThrow("another project");
    rmSync(path);
    symlinkSync("/etc/hosts", path);
    expect(() => c.restore(edit.id, root)).toThrow("symbolic");
    rmSync(path);
    writeFileSync(path, "after");
    c.restore(edit.id, root);
    expect(() => c.restore(edit.id, root)).toThrow("already");
    const interrupted = c.capture(root, "note", "s");
    writeFileSync(path, "partial");
    expect(() => c.restore(interrupted.id, root)).toThrow("File changed");
  });
});
async function server(handler: RequestListener) {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
async function until(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 4000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
describe("Ollama model management", () => {
  it("uses real HTTP tags/pull/delete and requires streamed success", async () => {
    const events: any[] = [],
      requests: string[] = [];
    const endpoint = await server((req, res) => {
      requests.push(req.method + " " + req.url);
      if (req.url === "/api/tags")
        res.end(JSON.stringify({ models: [{ name: "test:tiny", size: 100 }] }));
      else if (req.url === "/api/pull") {
        res.write('{"status":"pulling","completed":1,');
        res.end('"total":2}\n{"status":"success"}\n');
      } else res.end();
    });
    const m = new LocalModels((e) => events.push(e));
    models.push(m);
    expect(await m.list(endpoint)).toMatchObject({
      models: [{ name: "test:tiny" }],
    });
    m.pull(endpoint, "test:tiny");
    await until(() => events.some((e) => e.done));
    expect(events.at(-1)).toMatchObject({ status: "Installed", done: true });
    await m.remove(endpoint, "test:tiny");
    expect(requests).toContain("DELETE /api/delete");
    expect(() => m.pull("https://example.com", "x")).toThrow("loopback");
  });
  it("reports truncated streams as failed and supports cancellation", async () => {
    const endpoint = await server((req, res) => {
      req.on("data", () => {});
      req.on("end", () => res.end('{"status":"pulling"}\n'));
    });
    const m = new LocalModels(() => {});
    models.push(m);
    m.pull(endpoint, "test");
    await until(() => m.states()[0].done);
    expect(m.states()[0]).toMatchObject({
      status: "Failed",
      error: "Download ended before Ollama confirmed success",
    });
    const hanging = await server((_req, res) => {
      res.writeHead(200);
      res.write('{"status":"pulling"}\n');
    });
    const d = m.pull(hanging, "test");
    m.cancel(d.id);
    await until(() => d.done);
    expect(d.status).toBe("Cancelled");
  });
});
describe("desktop appearance and shortcuts", () => {
  it("accepts JSONC colors and rejects CSS injection and missing surfaces", () => {
    expect(
      parseTheme(
        '{"name":"Quiet", // comment\n "colors":{"editor.background":"#111111", "editor.foreground":"#eeeeee",},}',
      ),
    ).toMatchObject({ name: "Quiet", colors: { "--bg": "#111111" } });
    expect(() =>
      parseTheme(
        '{"colors":{"editor.background":"url(https://evil)","editor.foreground":"#fff"}}',
      ),
    ).toThrow("Invalid color");
    expect(() => parseTheme('{"colors":{}}')).toThrow("needs editor");
  });
  it("prevents duplicate and editing-key collisions while retaining other defaults", () => {
    expect(parseShortcuts({ palette: "mod+shift+k" }).palette).toBe(
      "mod+shift+k",
    );
    expect(() => parseShortcuts({ palette: "mod+n" })).toThrow("Two actions");
    expect(() => parseShortcuts({ palette: "mod+c" })).toThrow("reserved");
    expect(() => parseShortcuts({ palette: "k" })).toThrow("use mod");
  });
});
