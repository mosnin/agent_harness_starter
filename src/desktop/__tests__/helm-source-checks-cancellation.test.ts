import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelmSourceChecks } from "../core/helm-source-checks";
import type { HelmIntegrationReview } from "../core/helm-integration";
let dir: string, root: string, review: HelmIntegrationReview;
const services: HelmSourceChecks[] = [];
const scope = () => ({ root, owner: "profile" });
const command = (body: string) => ({
  command: process.execPath,
  args: ["-e", body],
});
const marker = () =>
  command("require('fs').writeFileSync('must-not-run','bad')");
const deferred = () => {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { resolve, promise };
};
function service(fingerprint = async () => "same", emit = () => {}) {
  const instance = new HelmSourceChecks(
    dir,
    { review: () => ({ ...review }), fingerprint },
    emit,
  );
  services.push(instance);
  return instance;
}
async function settled(instance: HelmSourceChecks, id: string) {
  for (let i = 0; i < 300; i++) {
    const receipt = await instance.get(id, scope());
    if (receipt.status !== "running") return receipt;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Did not settle");
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "source-check-stop-")));
  root = join(dir, "root");
  mkdirSync(root);
  review = {
    id: "11111111-1111-4111-8111-111111111111",
    runId: "run",
    root,
    owner: "profile",
    revision: "rev",
    sourceRevision: "source",
    patch: "",
    files: [],
    status: "applied",
    createdAt: 1,
    requiresSourceChecks: true,
  };
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
  rmSync(dir, { recursive: true, force: true });
});
it("pre-aborted admission does not even fingerprint or save a receipt", async () => {
  const fingerprint = vi.fn(async () => "same"),
    s = service(fingerprint),
    c = new AbortController();
  c.abort();
  await expect(
    s.start(review.id, scope(), [marker()], 10, { signal: c.signal }),
  ).rejects.toThrow();
  expect(fingerprint).not.toHaveBeenCalled();
  expect(await s.list(review.id, scope())).toEqual([]);
});
it("Stop during initial fingerprint rejects before any receipt or command exists", async () => {
  const gate = deferred(),
    s = service(() => gate.promise),
    c = new AbortController();
  const pending = s.start(review.id, scope(), [marker()], 10, {
    signal: c.signal,
  });
  c.abort();
  gate.resolve("same");
  await expect(pending).rejects.toThrow();
  expect(await s.list(review.id, scope())).toEqual([]);
  expect(existsSync(join(root, "must-not-run"))).toBe(false);
  expect(s.hasActiveWork()).toBe(false);
});
it("synchronous authority guard is rechecked after fingerprint", async () => {
  const gate = deferred(),
    s = service(() => gate.promise);
  let allowed = true;
  const pending = s.start(review.id, scope(), [marker()], 10, {
    assertActive: () => {
      if (!allowed) throw new Error("Work attempt stopped");
    },
  });
  allowed = false;
  gate.resolve("same");
  await expect(pending).rejects.toThrow("Work attempt stopped");
  expect(existsSync(join(root, "must-not-run"))).toBe(false);
  expect(await s.list(review.id, scope())).toEqual([]);
});
it("close during fingerprint forbids a later command even after close has returned", async () => {
  const gate = deferred(),
    s = service(() => gate.promise),
    pending = s.start(review.id, scope(), [marker()]);
  await s.close();
  gate.resolve("same");
  await expect(pending).rejects.toThrow("closed");
  expect(existsSync(join(root, "must-not-run"))).toBe(false);
});
it("abort from first receipt publication cannot launch a command", async () => {
  const c = new AbortController(),
    s = service(
      async () => "same",
      () => c.abort(),
    );
  const receipt = await s.start(review.id, scope(), [marker()], 10, {
    signal: c.signal,
  });
  expect((await settled(s, receipt.id)).status).toBe("cancelled");
  expect(existsSync(join(root, "must-not-run"))).toBe(false);
});
it("close from first receipt publication awaits execution ownership and prevents spawn", async () => {
  let closing: Promise<void> | undefined, s: HelmSourceChecks;
  s = service(
    async () => "same",
    () => {
      if (!closing) {
        closing = Promise.resolve();
        closing = s.close();
      }
    },
  );
  const receipt = await s.start(review.id, scope(), [marker()]);
  await closing;
  expect(s.hasActiveWork()).toBe(false);
  expect((await s.get(receipt.id, scope())).status).toBe("interrupted");
  expect(existsSync(join(root, "must-not-run"))).toBe(false);
});
it("authority revocation after first command prevents the next command", async () => {
  let allowed = true,
    count = 0;
  const s = service(
    async () => "same",
    () => {
      if (++count === 2) allowed = false;
    },
  );
  const receipt = await s.start(
    review.id,
    scope(),
    [command("process.exit(0)"), marker()],
    10,
    {
      assertActive: () => {
        if (!allowed) throw new Error("Work reservation revoked");
      },
    },
  );
  const done = await settled(s, receipt.id);
  expect(done.status).toBe("cancelled");
  expect(done.results).toHaveLength(1);
  expect(done.results[0].exitCode).toBe(0);
  expect(existsSync(join(root, "must-not-run"))).toBe(false);
});
it("external signal kills a running owned process and cancel awaits its exit", async () => {
  const c = new AbortController(),
    s = service(),
    receipt = await s.start(
      review.id,
      scope(),
      [
        command(
          "require('fs').writeFileSync('pid',String(process.pid));setInterval(()=>{},1000)",
        ),
      ],
      10,
      { signal: c.signal },
    );
  for (let i = 0; i < 300 && !existsSync(join(root, "pid")); i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(existsSync(join(root, "pid"))).toBe(true);
  const pid = Number(readFileSync(join(root, "pid"), "utf8"));
  c.abort();
  const done = await s.cancel(receipt.id, scope());
  expect(done.status).toBe("cancelled");
  expect(s.hasActiveWork()).toBe(false);
  expect(() => process.kill(pid, 0)).toThrow();
});
