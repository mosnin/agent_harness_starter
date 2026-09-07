/** Exercise the shipped Node/sidecar/PTY, without model credentials or user data. */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
if (process.platform !== "darwin") throw new Error("macOS bundle required");
const resources = resolve("dist-mac/Hades.app/Contents/Resources");
const root = mkdtempSync(join(tmpdir(), "hades-bundle-smoke-"));
const child = spawn(
  join(resources, "node"),
  [join(resources, "sidecar-entry.js")],
  {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HADES_DATA_DIR: join(root, "data"),
      HADES_PTY: join(resources, "hades-pty"),
    },
    stdio: "pipe",
  },
);
let stderr = "",
  output = "",
  counter = 0;
const events = [];
const pending = new Map();
child.stderr.on("data", (data) => (stderr += data));
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const event = JSON.parse(line);
  if (process.argv.includes("--local")) events.push(event);
  if (event.kind === "desktop.response") pending.get(event.id)?.(event);
  if (event.kind === "desktop.terminal") output += event.chunk;
});
const exited = new Promise((resolve) =>
  child.once("exit", (code, signal) => resolve({ code, signal })),
);
function request(method, args = {}) {
  const id = String(++counter);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out: ${stderr}`));
    }, 10000);
    pending.set(id, (event) => {
      clearTimeout(timer);
      pending.delete(id);
      event.error ? reject(new Error(event.error)) : resolve(event.result);
    });
    child.stdin.write(
      JSON.stringify({ kind: "desktop.request", id, method, args }) + "\n",
    );
  });
}
const children = (pid) => {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .map(Number);
  } catch {
    return [];
  }
};
try {
  const boot = await request("boot");
  assert.equal(boot.profiles[0].name, "Hades");
  await request("project.add", { path: root });
  let localProvider;
  if (process.argv.includes("--local")) {
    const catalog = await request("local.list", {
      endpoint: "http://127.0.0.1:11434",
    });
    const model = process.env.HADES_SMOKE_MODEL || "qwen3.5:latest";
    assert.ok(
      catalog.models.some((m) => m.name === model),
      `Install ${model} in Ollama before running --local`,
    );
    await request("profile.save", {
      id: "default",
      name: "Local verification",
      provider: "local",
      model,
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    const session = await request("session.new", { root });
    await request("chat.send", {
      id: session.id,
      input: "Reply with exactly HADES_LOCAL_OK. Do not call tools.",
    });
    const until = Date.now() + 120000;
    while (
      !events.some(
        (e) => e.kind === "desktop.done" && e.session === session.id,
      ) &&
      Date.now() < until
    )
      await new Promise((r) => setTimeout(r, 50));
    const failure = events.find(
      (e) => e.kind === "desktop.error" && e.session === session.id,
    );
    assert.equal(failure, undefined, failure?.message);
    assert.ok(
      events.some((e) => e.kind === "desktop.done" && e.session === session.id),
      "Local model did not finish",
    );
    const record = await request("session.get", { id: session.id });
    assert.ok(
      record.messages.at(-1)?.content.includes("HADES_LOCAL_OK"),
      "Local model did not produce the requested response",
    );
    localProvider = {
      model,
      installedModels: catalog.models.length,
      streamed: events.some((e) => e.kind === "desktop.delta"),
      persisted: record.messages.length === 2,
    };
  }
  const terminal = await request("terminal.open", { root });
  await request("terminal.resize", { id: terminal.id, cols: 72, rows: 24 });
  await request("terminal.write", {
    id: terminal.id,
    input: "printf '%s_%s\\n' HADES_BUNDLE VERIFIED\n",
  });
  const deadline = Date.now() + 5000;
  while (!output.includes("HADES_BUNDLE_VERIFIED") && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(output.includes("HADES_BUNDLE_VERIFIED"), output);
  const pids = children(child.pid);
  const descendants = [...pids, ...pids.flatMap(children)];
  if (process.argv.includes("--signal")) child.kill("SIGTERM");
  else child.stdin.end();
  const result = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Backend did not exit after EOF")),
        5000,
      ).unref(),
    ),
  ]);
  assert.equal(result.code, 0, stderr);
  for (const pid of descendants) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `Child ${pid} was not reaped`);
  }
  console.log(
    JSON.stringify({
      packagedMacBackend: "passed",
      interactivePty: "passed",
      resize: "passed",
      shutdown: process.argv.includes("--signal")
        ? "SIGTERM passed"
        : "EOF passed",
      externalRuntimeRequired: false,
      ...(localProvider ? { localProvider } : {}),
    }),
  );
} finally {
  child.kill();
  lines.close();
  rmSync(root, { recursive: true, force: true });
}
