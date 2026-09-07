import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import {
  WorkbenchService,
  type WorkbenchEvent,
} from "../core/workbench-service";
const roots: string[] = [];
const services: WorkbenchService[] = [];
const servers: Server[] = [];
afterEach(() => {
  services.forEach((s) => s.close());
  servers.forEach((s) => s.closeAllConnections());
  servers.forEach((s) => s.close());
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
  services.length = servers.length = roots.length = 0;
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "hades-desktop-test-"));
  roots.push(root);
  const events: WorkbenchEvent[] = [];
  const s = new WorkbenchService(join(root, "data"), (e) => events.push(e), {
    NODE_ENV: "test",
  });
  services.push(s);
  return { root, s, events };
}
async function until(fn: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function provider(reply: (input: string) => string) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      requests.push(body);
      const message = reply(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [message.slice(0, 8), message.slice(8)])
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
        );
      res.end(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    requests,
  };
}
describe("native desktop workbench", () => {
  it("requires explicit project access and confines previews including symlinks", async () => {
    const { root, s } = setup();
    writeFileSync(join(root, "file.txt"), "hello");
    await expect(
      s.dispatch("files.read", { root, path: "file.txt" }),
    ).rejects.toThrow("Open this project");
    await s.dispatch("project.add", { path: root });
    expect(
      await s.dispatch("files.read", { root, path: "file.txt" }),
    ).toMatchObject({ text: "hello" });
    symlinkSync("/etc", join(root, "outside"));
    await expect(
      s.dispatch("files.read", { root, path: "outside/hosts" }),
    ).rejects.toThrow("outside");
  });
  it("persists projects and profiles without writing credentials to disk or snapshots", async () => {
    const { root, s } = setup();
    await s.dispatch("project.add", { path: root });
    await s.dispatch("key.set", {
      account: "default:openai",
      key: "test-secret-do-not-persist",
    });
    const settings = readFileSync(join(root, "data/desktop.json"), "utf8");
    expect(settings).not.toContain("test-secret");
    expect(JSON.stringify(await s.dispatch("boot", {}))).not.toContain(
      "test-secret",
    );
    const restored = new WorkbenchService(join(root, "data"), () => {}, {
      NODE_ENV: "test",
    });
    services.push(restored);
    expect(await restored.dispatch("boot", {})).toMatchObject({
      projects: [realpathSync(root)],
    });
  });
  it("streams a real HTTP response and persists it in the shared CLI session format", async () => {
    const { root, s, events } = setup();
    const p = await provider(() => "ANSWER: Hello from the test provider.");
    await s.dispatch("project.add", { path: root });
    await s.dispatch("profile.save", {
      id: "default",
      name: "Test",
      provider: "local",
      model: "test-model",
      baseUrl: p.url,
    });
    const session = (await s.dispatch("session.new", { root })) as {
      id: string;
    };
    await s.dispatch("chat.send", { id: session.id, input: "Hello" });
    await until(() => events.some((e) => e.kind === "desktop.done"));
    expect(
      events
        .filter((e) => e.kind === "desktop.delta")
        .map((e) => e.chunk)
        .join(""),
    ).toBe("ANSWER: Hello from the test provider.");
    const stored = JSON.parse(
      readFileSync(join(root, "data/sessions.json"), "utf8"),
    );
    expect(stored[0].messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(stored[0].messages[1].content).toBe("Hello from the test provider.");
    expect(p.requests.length).toBe(1);
  });
  it("blocks file writes until an explicit approval and allows cancellation while waiting", async () => {
    const { root, s, events } = setup();
    const p = await provider((body) =>
      JSON.parse(body).messages.at(-1).content.startsWith("TOOL_RESULT:")
        ? "ANSWER: Written"
        : 'TOOL: file_ops\nINPUT: {"op":"write","path":"result.txt","content":"approved"}',
    );
    await s.dispatch("project.add", { path: root });
    await s.dispatch("profile.save", {
      id: "default",
      name: "Test",
      provider: "local",
      model: "test",
      baseUrl: p.url,
    });
    const session = (await s.dispatch("session.new", { root })) as {
      id: string;
    };
    await s.dispatch("chat.send", { id: session.id, input: "Write the file" });
    await until(() => events.some((e) => e.kind === "desktop.approval"));
    expect(existsSync(join(root, "result.txt"))).toBe(false);
    await s.dispatch("approval.reply", {
      id: events.find((e) => e.kind === "desktop.approval")!.id,
      allow: true,
    });
    await until(() => events.some((e) => e.kind === "desktop.done"));
    expect(readFileSync(join(root, "result.txt"), "utf8")).toBe("approved");
    const second = (await s.dispatch("session.new", { root })) as {
      id: string;
    };
    await s.dispatch("chat.send", { id: second.id, input: "Write again" });
    await until(() =>
      events.some(
        (e) => e.kind === "desktop.approval" && e.session === second.id,
      ),
    );
    await s.dispatch("chat.stop", { id: second.id });
    await until(() =>
      events.some((e) => e.kind === "desktop.done" && e.session === second.id),
    );
    expect(
      events.some((e) => e.kind === "desktop.error" && e.session === second.id),
    ).toBe(true);
  });
  it("fails before persisting a user turn when provider credentials are missing", async () => {
    const { root, s } = setup();
    await s.dispatch("project.add", { path: root });
    const session = (await s.dispatch("session.new", { root })) as {
      id: string;
    };
    await expect(
      s.dispatch("chat.send", { id: session.id, input: "Hello" }),
    ).rejects.toThrow("API key");
    expect(await s.dispatch("session.get", { id: session.id })).toMatchObject({
      messages: [],
    });
  });
  it("isolates profile sessions and rejects insecure remote endpoints", async () => {
    const { root, s } = setup();
    await s.dispatch("project.add", { path: root });
    const session = (await s.dispatch("session.new", { root })) as {
      id: string;
    };
    await s.dispatch("profile.save", {
      id: "other",
      name: "Other",
      provider: "local",
      model: "test",
      baseUrl: "http://localhost:11434/v1",
    });
    await expect(s.dispatch("session.get", { id: session.id })).rejects.toThrow(
      "not found",
    );
    await expect(
      s.dispatch("profile.save", {
        name: "Bad",
        provider: "local",
        model: "x",
        baseUrl: "http://example.com",
      }),
    ).rejects.toThrow("HTTPS");
  });
});

describe("desktop persistent workflows", () => {
  it("edits files, stages changes and commits in a real Git repository including deleted files", async () => {
    const { root, s } = setup();
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.name", "Hades Test");
    git("config", "user.email", "hades@example.invalid");
    await s.dispatch("project.add", { path: root });
    expect(await s.dispatch("git.status", { root })).toMatchObject({
      diff: "",
    });
    writeFileSync(join(root, "note.txt"), "before");
    await s.dispatch("files.save", {
      root,
      path: "note.txt",
      content: "after",
    });
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("after");
    await s.dispatch("git.action", { root, action: "stage", path: "note.txt" });
    await s.dispatch("git.action", {
      root,
      action: "commit",
      message: "Save note",
    });
    expect(git("show", "HEAD:note.txt")).toBe("after");
    rmSync(join(root, "note.txt"));
    await s.dispatch("git.action", { root, action: "stage", path: "note.txt" });
    expect(
      ((await s.dispatch("git.status", { root, staged: true })) as any).diff,
    ).toContain("deleted file");
    await expect(
      s.dispatch("git.action", { root, action: "stage", path: "../outside" }),
    ).rejects.toThrow("inside");
  }, 20_000); // Multiple real Git subprocesses include cold macOS executable startup.
  it("exports and imports memory and skills without process-launching settings", async () => {
    const { s } = setup();
    await s.dispatch("memory.add", { fact: "Keep replies concise" });
    await s.dispatch("skills.save", {
      name: "review",
      content: "# Review\nCheck the diff.",
    });
    const exported = await s.dispatch("profile.export", { id: "default" });
    const imported = (await s.dispatch("profile.import", {
      content: JSON.stringify(exported),
    })) as any;
    expect(imported.id).not.toBe("default");
    expect(imported.shell).toEqual([]);
    expect(imported.mcp).toEqual([]);
    expect(await s.dispatch("memory.list", { profile: imported.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fact: "Keep replies concise" }),
      ]),
    );
    expect(await s.dispatch("skills.list", { profile: imported.id })).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "review" })]),
    );
  });
  it("runs a routine through the real HTTP model and saves its result", async () => {
    const { s, root, events } = setup();
    const p = await provider(() => "ANSWER: Routine completed.");
    await s.dispatch("project.add", { path: root });
    await s.dispatch("profile.save", {
      id: "default",
      name: "Hades",
      provider: "local",
      model: "test-model",
      baseUrl: p.url,
    });
    const job = (await s.dispatch("job.save", {
      name: "Daily note",
      prompt: "Write a note",
      root,
      intervalMinutes: 60,
      cron: "0 9 * * *",
      timeZone: "America/New_York",
    })) as any;
    expect(job.nextAt).toBeGreaterThan(Date.now());
    await s.dispatch("job.toggle", { id: job.id, enabled: false });
    const run = (await s.dispatch("job.run", { id: job.id })) as any;
    await until(() =>
      events.some(
        (e) => e.kind === "desktop.done" && e.session === run.session,
      ),
    );
    const session = (await s.dispatch("session.get", {
      id: run.session,
    })) as any;
    expect(session.messages.at(-1).content).toContain("Routine completed");
    expect(((await s.dispatch("boot", {})) as any).jobs[0].enabled).toBe(false);
  });
});
