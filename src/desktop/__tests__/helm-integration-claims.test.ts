import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { HelmService } from "../core/helm-service.js";
import {
  HelmIntegration,
  type HelmIntegrationReview,
} from "../core/helm-integration.js";
let dir: string,
  root: string,
  service: HelmService,
  integration: HelmIntegration;
const children: ChildProcess[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const scope = () => ({ root, owner: "profile", parentSession: "parent" });
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
const file = (review: HelmIntegrationReview) =>
  join(dir, "data", "helm", "integration", review.id + ".json");
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "helm-claim-")));
  root = join(dir, "repo");
  execFileSync("git", ["init", root], { stdio: "pipe" });
  git("config", "user.name", "QA");
  git("config", "user.email", "qa@example.test");
  writeFileSync(join(root, "a.txt"), "base\n");
  writeFileSync(join(root, "delete.txt"), "delete");
  git("add", ".");
  git("commit", "-m", "base");
  service = new HelmService(join(dir, "data"), () => {}, {
    runBuiltin: async (input) => {
      writeFileSync(join(input.root, "a.txt"), "changed\n");
      unlinkSync(join(input.root, "delete.txt"));
      writeFileSync(join(input.root, "new.bin"), Buffer.from([0, 1, 255, 3]));
      return { output: "done" };
    },
  });
  integration = new HelmIntegration(join(dir, "data"), service);
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  vi.restoreAllMocks();
  await Promise.all(service.list().map((r) => service.cancel(r.id)));
  service.close();
  rmSync(dir, { recursive: true, force: true });
});
async function ready() {
  const run = await service.start({
    ...scope(),
    agent: "hades",
    prompt: "fixture",
  });
  for (
    let n = 0;
    n < 300 && ["running", "starting"].includes(service.get(run.id).status);
    n++
  )
    await new Promise((r) => setTimeout(r, 10));
  await service.verify(run.id, [
    { command: process.execPath, args: ["-e", "process.exit(0)"] },
  ]);
  return run.id;
}
function unchanged() {
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("base\n");
  expect(existsSync(join(root, "new.bin"))).toBe(false);
  expect(existsSync(join(root, "delete.txt"))).toBe(true);
}
// Instrument just the final effect launch; all validation, claims and real Git commands still execute.
type Internals = {
  git(
    root: string,
    args: string[],
    index?: string,
    signal?: AbortSignal,
  ): Promise<string>;
};
it("pre-aborted and final active-guard cancellation have no file effects and allow explicit later apply", async () => {
  const review = await integration.prepare(await ready(), scope());
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    integration.apply(review.id, scope(), hash(review.patch), {
      signal: aborted.signal,
    }),
  ).rejects.toThrow();
  unchanged();
  await expect(
    integration.apply(review.id, scope(), hash(review.patch), {
      assertActive: () => {
        if (
          JSON.parse(readFileSync(file(review), "utf8")).status === "applying"
        )
          throw new Error("Work stopped");
      },
    }),
  ).rejects.toThrow("Work stopped");
  unchanged();
  expect(integration.get(review.id, scope()).status).toBe("prepared");
  expect(
    (await integration.apply(review.id, scope(), hash(review.patch))).status,
  ).toBe("applied");
});
it("rechecks cancellation after a queued apply settles", async () => {
  const review = await integration.prepare(await ready(), scope());
  const internals = integration as unknown as Internals,
    original = internals.git.bind(internals);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (entered = r));
  vi.spyOn(internals, "git").mockImplementation(
    async (r, args, index, signal) => {
      if (args[0] === "apply" && !args.includes("--check")) {
        entered();
        await gate;
      }
      return original(r, args, index, signal);
    },
  );
  const first = integration.apply(review.id, scope(), hash(review.patch));
  await seen;
  const abort = new AbortController();
  const second = integration.apply(review.id, scope(), hash(review.patch), {
    signal: abort.signal,
  });
  const rejection = expect(second).rejects.toThrow();
  abort.abort();
  release();
  await first;
  await rejection;
});
it("post-dispatch abort retains unknown claims and never replays after reopening", async () => {
  const review = await integration.prepare(await ready(), scope());
  const internals = integration as unknown as Internals,
    original = internals.git.bind(internals),
    abort = new AbortController();
  let effects = 0;
  vi.spyOn(internals, "git").mockImplementation(
    async (r, args, index, signal) => {
      const result = await original(r, args, index, signal);
      if (args[0] === "apply" && !args.includes("--check")) {
        effects++;
        abort.abort();
      }
      return result;
    },
  );
  await expect(
    integration.apply(review.id, scope(), hash(review.patch), {
      signal: abort.signal,
    }),
  ).rejects.toThrow();
  expect(effects).toBe(1);
  expect(integration.get(review.id, scope()).status).toBe("unknown");
  const reopened = new HelmIntegration(join(dir, "data"), service);
  await expect(
    reopened.apply(review.id, scope(), hash(review.patch)),
  ).rejects.toThrow("uncertain");
  expect(effects).toBe(1);
});
it("binds retained claims to the complete scoped review body", async () => {
  const review = await integration.prepare(await ready(), scope());
  const abort = new AbortController();
  const internal = integration as unknown as Internals,
    original = internal.git.bind(internal);
  vi.spyOn(internal, "git").mockImplementation(
    async (r, args, index, signal) => {
      if (args[0] === "apply" && !args.includes("--check")) {
        abort.abort();
        throw new Error("uncertain child");
      }
      return original(r, args, index, signal);
    },
  );
  await expect(
    integration.apply(review.id, scope(), hash(review.patch), {
      signal: abort.signal,
    }),
  ).rejects.toThrow("uncertain");
  writeFileSync(
    file(review),
    JSON.stringify({
      ...review,
      status: "prepared",
      sourceRevision: "changed",
    }),
  );
  await expect(
    new HelmIntegration(join(dir, "data"), service).apply(
      review.id,
      scope(),
      hash(review.patch),
    ),
  ).rejects.toThrow("binding changed");
  unchanged();
});
it("rejects body replacement at final dispatch without changing source", async () => {
  const review = await integration.prepare(await ready(), scope());
  let changed = false;
  await expect(
    integration.apply(review.id, scope(), hash(review.patch), {
      assertActive: () => {
        const current = JSON.parse(readFileSync(file(review), "utf8"));
        if (!changed && current.status === "applying") {
          changed = true;
          writeFileSync(
            file(review),
            JSON.stringify({ ...current, files: [] }),
          );
        }
      },
    }),
  ).rejects.toThrow("Reviewed integration body changed");
  unchanged();
});
it("a real process claim excludes another data directory and survives SIGKILL without replay", async () => {
  const id = await ready(),
    review = await integration.prepare(id, scope()),
    other = new HelmIntegration(join(dir, "other"), service),
    otherReview = await other.prepare(id, scope());
  const metadata = join(dir, "metadata.json");
  writeFileSync(
    metadata,
    JSON.stringify({
      run: service.get(id),
      diff: await service.diff(id),
      review,
      scope: scope(),
      data: join(dir, "data"),
    }),
  );
  const script = join(dir, "child.mjs");
  writeFileSync(
    script,
    `
 import { readFileSync } from 'node:fs';
 import { createHash } from 'node:crypto';
 import { HelmIntegration } from ${JSON.stringify(resolve("src/desktop/core/helm-integration.ts"))};
 const f=JSON.parse(readFileSync(process.argv[2],'utf8'));
 const h=new HelmIntegration(f.data,{get:()=>f.run,diff:async()=>f.diff,ownsWorkspace:w=>w===f.run.workspace});
 const original=h.git.bind(h);h.git=async(...args)=>{if(args[1][0]==='apply'&&!args[1].includes('--check')){process.stdout.write('CLAIMED\\n');await new Promise(()=>setInterval(()=>{},1000));}return original(...args);};
 await h.apply(f.review.id,f.scope,createHash('sha256').update(f.review.patch).digest('hex'));
 `,
  );
  const child = spawn(
    process.execPath,
    ["--import", resolve("node_modules/tsx/dist/loader.mjs"), script, metadata],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (c) => (stderr += String(c)));
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Child claim timeout: " + stderr)),
      10000,
    );
    child.stdout!.on("data", (chunk) => {
      if (String(chunk).includes("CLAIMED")) {
        clearTimeout(timer);
        done();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("Child exited " + code + ": " + stderr));
    });
  });
  unchanged();
  await expect(
    other.apply(otherReview.id, scope(), hash(otherReview.patch)),
  ).rejects.toThrow("already claimed");
  child.kill("SIGKILL");
  await once(child, "exit");
  await expect(
    new HelmIntegration(join(dir, "data"), service).apply(
      review.id,
      scope(),
      hash(review.patch),
    ),
  ).rejects.toThrow("uncertain");
  await expect(
    other.apply(otherReview.id, scope(), hash(otherReview.patch)),
  ).rejects.toThrow("already claimed");
  unchanged();
}, 20000);
it("successful claim preserves dirty/staged index plus binary/deletion effects and historical idempotence", async () => {
  const id = await ready();
  writeFileSync(join(root, "local"), "staged");
  git("add", "local");
  writeFileSync(join(root, "local"), "dirty");
  const index = readFileSync(join(root, ".git", "index"));
  const review = await integration.prepare(id, scope());
  const result = await integration.apply(
    review.id,
    scope(),
    hash(review.patch),
  );
  expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
  expect(readFileSync(join(root, "local"), "utf8")).toBe("dirty");
  expect(readFileSync(join(root, "new.bin"))).toEqual(
    Buffer.from([0, 1, 255, 3]),
  );
  expect(existsSync(join(root, "delete.txt"))).toBe(false);
  expect(
    (
      await new HelmIntegration(join(dir, "data"), service).apply(
        review.id,
        scope(),
        hash(review.patch),
      )
    ).appliedAt,
  ).toBe(result.appliedAt);
});

it.skipIf(process.platform === "win32")(
  "recovers real SIGKILL after durable applied save without replaying or blocking the source forever",
  async () => {
    const id = await ready(),
      review = await integration.prepare(id, scope()),
      index = readFileSync(join(root, ".git", "index"));
    const metadata = join(dir, "applied-metadata.json");
    writeFileSync(
      metadata,
      JSON.stringify({
        run: service.get(id),
        diff: await service.diff(id),
        review,
        scope: scope(),
        data: join(dir, "data"),
      }),
    );
    const script = join(dir, "applied-child.mjs");
    writeFileSync(
      script,
      `
 import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
 import {HelmIntegration} from ${JSON.stringify(resolve("src/desktop/core/helm-integration.ts"))};
 const f=JSON.parse(readFileSync(process.argv[2],'utf8'));
 const h=new HelmIntegration(f.data,{get:()=>f.run,diff:async()=>f.diff,ownsWorkspace:w=>w===f.run.workspace});
 const original=h.save.bind(h);h.save=review=>{original(review);if(review.status==='applied')process.kill(process.pid,'SIGKILL');};
 await h.apply(f.review.id,f.scope,createHash('sha256').update(f.review.patch).digest('hex'));
 `,
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        script,
        metadata,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (c) => (stderr += String(c)));
    const [code, signal] = await once(child, "exit");
    expect({ code, signal }, stderr).toEqual({ code: null, signal: "SIGKILL" });
    const rootClaim = join(
      root,
      ".git",
      "hades-integration-claims",
      hash(root) + ".claim",
    );
    expect(existsSync(rootClaim)).toBe(true);
    expect(integration.get(review.id, scope()).status).toBe("applied");
    const reopened = new HelmIntegration(join(dir, "data"), service),
      completed = await reopened.reconcileApplied(review.id, scope());
    expect(completed.status).toBe("applied");
    expect(existsSync(rootClaim)).toBe(false);
    expect(
      (await reopened.apply(review.id, scope(), hash(review.patch))).appliedAt,
    ).toBe(completed.appliedAt);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
    expect(readFileSync(join(root, "new.bin"))).toEqual(
      Buffer.from([0, 1, 255, 3]),
    );
    expect(existsSync(join(root, "delete.txt"))).toBe(false);
  },
  20000,
);
it.each(["token", "root", "reviewId", "binding", "patchHash"])(
  "preserves a completed root claim with mismatched %s",
  async (field) => {
    const review = await integration.prepare(await ready(), scope());
    await integration.apply(review.id, scope(), hash(review.patch));
    const retained = JSON.parse(
      readFileSync(
        join(dir, "data", "helm", "integration", review.id + ".apply-claim"),
        "utf8",
      ),
    );
    const rootClaim = join(
        root,
        ".git",
        "hades-integration-claims",
        hash(root) + ".claim",
      ),
      foreign = JSON.stringify({ ...retained, [field]: "foreign" });
    writeFileSync(rootClaim, foreign);
    await expect(
      integration.reconcileApplied(review.id, scope()),
    ).rejects.toThrow("ownership changed");
    expect(readFileSync(rootClaim, "utf8")).toBe(foreign);
  },
);
it("allows a delayed matching finally release after recovery, but preserves a newly acquired foreign claim", async () => {
  const review = await integration.prepare(await ready(), scope());
  await integration.apply(review.id, scope(), hash(review.patch));
  const retained = JSON.parse(
    readFileSync(
      join(dir, "data", "helm", "integration", review.id + ".apply-claim"),
      "utf8",
    ),
  );
  const rootClaim = join(
    root,
    ".git",
    "hades-integration-claims",
    hash(root) + ".claim",
  );
  writeFileSync(rootClaim, JSON.stringify(retained));
  await integration.reconcileApplied(review.id, scope());
  const internals = integration as unknown as {
    release(path: string, claim: typeof retained): void;
  };
  expect(() => internals.release(rootClaim, retained)).not.toThrow();
  const foreign = JSON.stringify({ ...retained, token: "foreign" });
  writeFileSync(rootClaim, foreign);
  expect(() => internals.release(rootClaim, retained)).toThrow(
    "ownership changed",
  );
  expect(readFileSync(rootClaim, "utf8")).toBe(foreign);
});
it("never reconciles applying or unknown receipts as completed", async () => {
  const review = await integration.prepare(await ready(), scope());
  for (const status of ["applying", "unknown"]) {
    writeFileSync(file(review), JSON.stringify({ ...review, status }));
    await expect(
      integration.reconcileApplied(review.id, scope()),
    ).rejects.toThrow("not known applied");
  }
  unchanged();
});
