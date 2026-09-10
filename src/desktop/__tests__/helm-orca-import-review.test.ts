import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  rmSync,
  realpathSync,
  renameSync,
  cpSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HelmOrcaService } from "../core/helm-orca-service";
import {
  orcaImportGit as git,
  materializeOrcaImport,
  assertOrcaImportDescriptor,
} from "../core/helm-orca-import";
const dirs: string[] = [];
const services: HelmOrcaService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orca-import-review-")));
  dirs.push(dir);
  const root = join(dir, "source"),
    workspace = join(dir, "worker");
  mkdirSync(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "qa@example.invalid"]);
  await git(root, ["config", "user.name", "QA"]);
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "deleted.txt"), "before");
  writeFileSync(join(root, "a.txt"), "base");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  await git(root, ["worktree", "add", "--detach", workspace]);
  const state = {
    base: "",
    observations: 0,
    wrongBase: false,
    secondLive: false,
  };
  const call = async (method: string, params: any) => {
    if (method === "orchestration.runCreate") return { run: { id: "run" } };
    if (method === "orchestration.workerStart") {
      state.base = params.baseBranch;
      return { state: "ready", dispatchId: "dispatch" };
    }
    if (method === "worktree.show")
      return {
        worktree: { id: "worker", repoId: "repo", git: { path: workspace } },
      };
    if (method === "orchestration.workerShow") {
      state.observations++;
      return {
        dispatch: { id: "dispatch" },
        worker: {
          dispatchId: "dispatch",
          runtimeEpoch: "runtime",
          startOptions: {
            baseBranch: state.wrongBase ? "f".repeat(40) : state.base,
          },
          worktreeId: "worker",
        },
        observation: {
          exactWorker: true,
          status:
            state.secondLive && state.observations > 1 ? "live" : "exited",
        },
      };
    }
    throw new Error("Unexpected method " + method);
  };
  const service = new HelmOrcaService(join(dir, "state"), {
    connect: async () => ({
      runtimeId: "runtime",
      repo: "repo",
      coordinator: "coordinator",
      call,
    }),
  });
  services.push(service);
  const scope = { root, profile: "profile" },
    id = randomUUID();
  await service.start(scope, {
    requestId: id,
    prompt: "fixture",
    agent: "codex",
  });
  return { dir, root, workspace, state, service, scope, id };
}
it.each(["import", ".git/import"])(
  "rejects materialization nested inside source or its Git metadata: %s",
  async (relative) => {
    const f = await fixture();
    const d = await f.service.prepareImport(f.scope, f.id),
      target = join(f.root, relative);
    await expect(materializeOrcaImport(d, target)).rejects.toThrow(
      "destination",
    );
    expect(existsSync(target)).toBe(false);
  },
);
it("rejects source directory replacement even with byte-identical Git metadata and HEAD", async () => {
  const f = await fixture();
  const moved = join(f.dir, "old-source");
  renameSync(f.root, moved);
  cpSync(moved, f.root, { recursive: true });
  await expect(f.service.prepareImport(f.scope, f.id)).rejects.toThrow(
    "Source identity changed",
  );
});
it("rejects workspace directory replacement after retained descriptor", async () => {
  const f = await fixture();
  const d = await f.service.prepareImport(f.scope, f.id),
    moved = join(f.dir, "old-worker");
  renameSync(f.workspace, moved);
  cpSync(moved, f.workspace, { recursive: true });
  await expect(assertOrcaImportDescriptor(d)).rejects.toThrow(
    "identity changed",
  );
});
it("rejects worker base mismatch and a second observation contradicting stopped state", async () => {
  const f = await fixture();
  f.state.wrongBase = true;
  await expect(f.service.prepareImport(f.scope, f.id)).rejects.toThrow(
    "unconfirmed",
  );
  f.state.wrongBase = false;
  f.state.observations = 0;
  f.state.secondLive = true;
  await expect(f.service.prepareImport(f.scope, f.id)).rejects.toThrow(
    "unconfirmed",
  );
});
it("binds workspace HEAD even when an empty commit leaves file bytes unchanged", async () => {
  const f = await fixture();
  const d = await f.service.prepareImport(f.scope, f.id);
  await git(f.workspace, ["commit", "--allow-empty", "-m", "changed head"]);
  await expect(assertOrcaImportDescriptor(d)).rejects.toThrow(
    "identity changed",
  );
});
it("preserves both exact indexes and dirty source while copying nested deletion, binary and literal symlinks", async () => {
  const f = await fixture();
  writeFileSync(join(f.root, "a.txt"), "source staged");
  await git(f.root, ["add", "a.txt"]);
  writeFileSync(join(f.root, "a.txt"), "source dirty");
  writeFileSync(join(f.workspace, "a.txt"), "worker staged");
  await git(f.workspace, ["add", "a.txt"]);
  writeFileSync(join(f.workspace, "a.txt"), "worker final");
  rmSync(join(f.workspace, "nested"), { recursive: true });
  const binary = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 256));
  writeFileSync(join(f.workspace, "new.bin"), binary);
  symlinkSync("../outside-secret", join(f.workspace, "link"));
  symlinkSync("../outside-secret", join(f.workspace, "second-link"));
  const sourceIndex = readFileSync(join(f.root, ".git", "index"));
  const workerIndexPath = (
      await git(f.workspace, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ])
    ).trim(),
    workerIndex = readFileSync(workerIndexPath);
  const d = await f.service.prepareImport(f.scope, f.id),
    target = join(f.dir, "imported");
  await materializeOrcaImport(d, target);
  expect(readFileSync(join(f.root, ".git", "index"))).toEqual(sourceIndex);
  expect(readFileSync(workerIndexPath)).toEqual(workerIndex);
  expect(readFileSync(join(f.root, "a.txt"), "utf8")).toBe("source dirty");
  expect(readFileSync(join(f.workspace, "a.txt"), "utf8")).toBe("worker final");
  expect(existsSync(join(target, "nested", "deleted.txt"))).toBe(false);
  expect(readFileSync(join(target, "new.bin"))).toEqual(binary);
  expect(readlinkSync(join(target, "link"))).toBe("../outside-secret");
  expect(readlinkSync(join(target, "second-link"))).toBe("../outside-secret");
});
it("refuses hidden index state and a redirected destination parent without writes", async () => {
  const f = await fixture();
  await git(f.workspace, ["update-index", "--assume-unchanged", "a.txt"]);
  await expect(f.service.prepareImport(f.scope, f.id)).rejects.toThrow(
    "Hidden index",
  );
  await git(f.workspace, ["update-index", "--no-assume-unchanged", "a.txt"]);
  const d = await f.service.prepareImport(f.scope, f.id);
  const alias = join(f.dir, "alias");
  symlinkSync(f.root, alias);
  await expect(materializeOrcaImport(d, join(alias, "escape"))).rejects.toThrow(
    "destination",
  );
  expect(existsSync(join(f.root, "escape"))).toBe(false);
});
