import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookService, type HookEvent } from "../core/shell-hooks";
const dirs: string[] = [], services: HookService[] = [];
afterEach(() => { services.forEach(s => s.close()); services.length = 0; dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0; });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "hades-hooks-")); dirs.push(dir); const service = new HookService(join(dir, "hooks.sqlite"), { root: path => { if (path !== dir) throw new Error("Unregistered root"); return dir; }, profile: id => { if (id !== "default") throw new Error("Wrong profile"); } }); services.push(service);
  const script = (content: string, name = "hook") => { const path = join(dir, name); writeFileSync(path, "#!/bin/sh\n" + content, { mode: 0o700 }); return path; };
  const event: HookEvent = { phase: "pre_tool", tool: "file_ops", session: "s1", profile: "default", root: dir, input: { action: "write" } };
  const save = (executable: string, extra = {}) => service.save({ name: "Check", root: dir, phase: "pre_tool", executable, ...extra }, "default"); return { dir, service, script, save, event }; }
describe("Consented native shell hooks (temporary executable fixtures)", () => {
  it("requires explicit consent, exact scope and matcher, and provides no inherited secrets", async () => {
    const f = fixture(), path = f.script('cat > input.json\nprintf "%s|%s" "$HOME" "$HADES_HOOK_TEST_SECRET" > environment.txt\nprintf done'); process.env.HADES_HOOK_TEST_SECRET = "must-not-leak";
    try { const row = f.save(path, { matcher: "file_ops" }); expect(row.status).toBe("inactive"); expect(await f.service.run(f.event, new AbortController().signal)).toEqual([]);
      f.service.consent(row.id, "default", true); expect(await f.service.run({ ...f.event, tool: "terminal" }, new AbortController().signal)).toEqual([]);
      const receipts = await f.service.run(f.event, new AbortController().signal); expect(receipts[0]).toMatchObject({ status: "completed", output: "done" }); expect(readFileSync(join(f.dir, "environment.txt"), "utf8")).toBe("|"); expect(JSON.parse(readFileSync(join(f.dir, "input.json"), "utf8"))).toMatchObject({ input: { action: "write" }, authority: expect.stringContaining("untrusted") });
      expect(() => f.service.consent(row.id, "other", true)).toThrow();
    } finally { delete process.env.HADES_HOOK_TEST_SECRET; }
  });
  it("invalidates consent on file/config changes and never executes changed content", async () => {
    const f = fixture(), path = f.script("printf first"), row = f.save(path); f.service.consent(row.id, "default", true); f.script("touch forbidden");
    expect(f.service.list("default")[0].status).toBe("needs_review"); expect((await f.service.run(f.event, new AbortController().signal))[0].status).toBe("failed"); expect(existsSync(join(f.dir, "forbidden"))).toBe(false);
    f.service.consent(row.id, "default", true); f.save(path, { id: row.id, name: "Edited" }); expect(f.service.list("default")[0].status).toBe("inactive");
    expect(() => f.save("/bin/sh", { args: ["-c", "anything"] })).toThrow("interpreter");
  });
  it("stops remaining pre hooks after failure but retains post hook failure receipts", async () => {
    const f = fixture(); for (const [path, phase] of [[f.script("exit 2", "fail"), "pre_tool"], [f.script("touch forbidden", "next"), "pre_tool"], [f.script("exit 3", "post"), "post_tool"]] as const) { const row = f.save(path, { phase }); f.service.consent(row.id, "default", true); }
    expect(await f.service.run(f.event, new AbortController().signal)).toHaveLength(1); expect(existsSync(join(f.dir, "forbidden"))).toBe(false);
    expect((await f.service.run({ ...f.event, phase: "post_tool", ok: true }, new AbortController().signal))[0]).toMatchObject({ status: "failed", error: "Hook exited with status 3." });
  });
  it("cancels the process group including delayed child effects and enforces timeout", async () => {
    const f = fixture(), row = f.save(f.script('(sleep 1; touch forbidden) &\nwait'), { timeoutSeconds: 1 }); f.service.consent(row.id, "default", true);
    const controller = new AbortController(), running = f.service.run(f.event, controller.signal); setTimeout(() => controller.abort(), 40);
    expect((await running)[0].status).toBe("cancelled"); await new Promise(resolve => setTimeout(resolve, 1100)); expect(existsSync(join(f.dir, "forbidden"))).toBe(false);
    f.script("sleep 10"); f.service.consent(row.id, "default", true); expect((await f.service.run(f.event, new AbortController().signal))[0]).toMatchObject({ status: "failed", error: "Hook timed out." });
  });
  it("terminates background children on successful completion and aborts disabled active hooks", async () => {
    const f = fixture(), row = f.save(f.script('(sleep 1; touch forbidden) >/dev/null 2>&1 &\nprintf done'));
    f.service.consent(row.id, "default", true); expect((await f.service.run(f.event, new AbortController().signal))[0].status).toBe("completed");
    await new Promise(resolve => setTimeout(resolve, 1100)); expect(existsSync(join(f.dir, "forbidden"))).toBe(false);
    f.script("sleep 10"); f.service.consent(row.id, "default", true); const running = f.service.run(f.event, new AbortController().signal); f.service.consent(row.id, "default", false); expect((await running)[0].status).toBe("cancelled");
  });

});
