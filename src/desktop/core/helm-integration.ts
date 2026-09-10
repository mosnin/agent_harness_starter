import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readdirSync,
  realpathSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { HelmRun, HelmDiff } from "./helm-types.js";
const exec = promisify(execFile);
const digest = (data: string) =>
  createHash("sha256").update(data).digest("hex");
const queues = new Map<string, Promise<unknown>>();
export interface HelmIntegrationScope {
  root: string;
  owner?: string;
  parentSession?: string;
}
export interface HelmIntegrationHost {
  get(id: string): HelmRun;
  diff(id: string): Promise<HelmDiff>;
  ownsWorkspace(root: string): boolean;
}
export interface HelmIntegrationReview {
  id: string;
  runId: string;
  root: string;
  owner?: string;
  parentSession?: string;
  revision: string;
  sourceRevision: string;
  patch: string;
  files: string[];
  status: "prepared" | "applying" | "applied" | "unknown";
  createdAt: number;
  appliedAt?: number;
  /** Checks certify the isolated task only. The resulting source needs new checks. */
  requiresSourceChecks: true;
}
/** Host-only review/apply boundary. No provider dispatch, commits, checkout or index writes.
 * Durable claims coordinate cooperating processes; unrelated editors/Git remain external actors. */
export interface HelmIntegrationApplyOptions {
  signal?: AbortSignal;
  assertActive?: () => void;
}
interface ApplyClaim {
  token: string;
  reviewId: string;
  root: string;
  binding: string;
  patchHash: string;
}
export class HelmIntegration {
  private directory: string;
  constructor(
    dataDir: string,
    private host: HelmIntegrationHost,
  ) {
    this.directory = join(dataDir, "helm", "integration");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(this.directory);
  }
  private async git(
    root: string,
    args: string[],
    index?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const env = { ...process.env };
    for (const name of Object.keys(env))
      if (name.startsWith("GIT_")) delete env[name];
    env.GIT_OPTIONAL_LOCKS = "0";
    if (index) env.GIT_INDEX_FILE = index;
    const { stdout } = await exec(
      "git",
      [
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: root,
        env,
        timeout: 30000,
        maxBuffer: 8_000_000,
        encoding: "utf8",
        ...(signal ? { signal } : {}),
      },
    );
    return stdout;
  }
  private scoped(run: HelmRun, scope: HelmIntegrationScope): void {
    if (
      realpathSync(scope.root) !== run.root ||
      run.owner !== scope.owner ||
      run.parentSession !== scope.parentSession
    )
      throw new Error("Helm integration scope mismatch");
    if (!this.host.ownsWorkspace(run.workspace))
      throw new Error("Workspace identity changed");
  }
  private async supported(
    root: string,
    extraPaths: string[] = [],
  ): Promise<void> {
    const config = await this.git(root, ["config", "--null", "--list"]);
    if (
      config
        .split("\0")
        .some((entry) =>
          /^filter\..*\.(clean|smudge|process)\n[\s\S]+$/.test(entry),
        )
    ) {
      const paths = (
        await this.git(root, [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter(Boolean)
        .concat(extraPaths);
      for (let offset = 0; offset < paths.length; offset += 100) {
        const attributes = (
          await this.git(root, [
            "check-attr",
            "-z",
            "filter",
            "--",
            ...paths.slice(offset, offset + 100),
          ])
        ).split("\0");
        if (
          attributes.some(
            (value, index) =>
              index % 3 === 2 && value !== "unspecified" && value !== "unset",
          )
        )
          throw new Error(
            "Git clean/smudge/process filters are not supported for integration",
          );
      }
    }
    const files = (await this.git(root, ["ls-files", "-v", "-z"]))
      .split("\0")
      .filter(Boolean);
    if (
      files.some((file) => file[0] === "S" || file[0] === file[0].toLowerCase())
    )
      throw new Error(
        "Clear skip-worktree and assume-unchanged flags before integration",
      );
    if (
      (await this.git(root, ["ls-files", "--stage", "-z"]))
        .split("\0")
        .some((file) => file.startsWith("160000 "))
    )
      throw new Error("Submodule integration is not supported");
  }
  sourceFingerprint(root: string): Promise<string> {
    return this.source(root);
  }
  private async source(root: string): Promise<string> {
    await this.supported(root);
    const hash = createHash("sha256");
    const stat = lstatSync(root);
    if (
      !stat.isDirectory() ||
      realpathSync(root) !== root ||
      realpathSync(
        (await this.git(root, ["rev-parse", "--show-toplevel"])).trim(),
      ) !== root
    )
      throw new Error("Source identity changed");
    hash.update(`${stat.dev}:${stat.ino}`);
    hash.update(await this.git(root, ["rev-parse", "HEAD"]));
    hash.update(
      await this.git(root, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--cached",
      ]),
    );
    hash.update(
      await this.git(root, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
      ]),
    );
    const files = (
      await this.git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    let size = 0;
    for (const file of files) {
      const path = join(root, file),
        stat = lstatSync(path);
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new Error("Unsupported source file");
      size += stat.size;
      if (size > 32_000_000)
        throw new Error("Source exceeds integration snapshot limit");
      hash
        .update("\0" + file + "\0" + stat.mode + "\0")
        .update(
          stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path),
        );
    }
    return hash.digest("hex");
  }
  private save(review: HelmIntegrationReview): void {
    const target = join(this.directory, review.id + ".json"),
      temp = target + "." + randomUUID();
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(review));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
    const dir = openSync(this.directory, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  get(id: string, scope: HelmIntegrationScope): HelmIntegrationReview {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new Error("Invalid integration identifier");
    const review: HelmIntegrationReview = JSON.parse(
      readFileSync(join(this.directory, id + ".json"), "utf8"),
    );
    this.scoped(this.host.get(review.runId), scope);
    if (
      review.root !== realpathSync(scope.root) ||
      review.owner !== scope.owner ||
      review.parentSession !== scope.parentSession
    )
      throw new Error("Helm integration scope mismatch");
    return review;
  }
  list(runId: string, scope: HelmIntegrationScope): HelmIntegrationReview[] {
    this.scoped(this.host.get(runId), scope);
    return readdirSync(this.directory)
      .filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))
      .map(
        (file) =>
          JSON.parse(
            readFileSync(join(this.directory, file), "utf8"),
          ) as HelmIntegrationReview,
      )
      .filter((review) => review.runId === runId)
      .map((review) => this.get(review.id, scope))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async prepare(
    runId: string,
    scope: HelmIntegrationScope,
  ): Promise<HelmIntegrationReview> {
    const run = this.host.get(runId);
    this.scoped(run, scope);
    const previous = this.list(runId, scope);
    if (
      previous.some(
        (review) => review.status === "applying" || review.status === "unknown",
      )
    )
      throw new Error(
        "Integration outcome uncertain. Inspect source; unresolved integration blocks a new review.",
      );
    await this.supported(run.root);
    await this.supported(run.workspace);
    const before = await this.host.diff(runId);
    if (
      run.status !== "verified" ||
      !run.verificationRevision ||
      before.stale ||
      before.revision !== run.verificationRevision
    )
      throw new Error("Verify the current task revision before integration");
    const alreadyApplied = previous.find(
      (review) =>
        review.status === "applied" && review.revision === before.revision,
    );
    if (alreadyApplied) return alreadyApplied;
    await this.supported(run.root, before.files);
    const sourceRevision = await this.source(run.root);
    const index = join(this.directory, randomUUID() + ".index");
    let patch: string;
    try {
      await this.git(run.workspace, ["read-tree", run.baseSha], index);
      await this.git(run.workspace, ["add", "-A", "--", "."], index);
      if (
        (await this.git(run.workspace, ["ls-files", "--stage", "-z"], index))
          .split("\0")
          .some((file) => file.startsWith("160000 "))
      )
        throw new Error(
          "Nested repositories and submodule integration are not supported",
        );
      patch = await this.git(
        run.workspace,
        [
          "diff",
          "--cached",
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          run.baseSha,
          "--",
        ],
        index,
      );
    } finally {
      if (existsSync(index)) unlinkSync(index);
    }
    if (!patch) throw new Error("Task has no changes to integrate");
    if (
      (await this.host.diff(runId)).revision !== before.revision ||
      (await this.source(run.root)) !== sourceRevision
    )
      throw new Error("Workspace or source changed during review preparation");
    const review: HelmIntegrationReview = {
      id: randomUUID(),
      runId,
      root: run.root,
      owner: run.owner,
      parentSession: run.parentSession,
      revision: before.revision,
      sourceRevision,
      patch,
      files: before.files,
      status: "prepared",
      createdAt: Date.now(),
      requiresSourceChecks: true,
    };
    await this.check(review);
    this.save(review);
    return review;
  }
  private active(options: HelmIntegrationApplyOptions): void {
    options.signal?.throwIfAborted();
    options.assertActive?.();
    options.signal?.throwIfAborted();
  }
  private binding(review: HelmIntegrationReview): string {
    return digest(
      JSON.stringify([
        review.id,
        review.runId,
        review.root,
        review.owner ?? null,
        review.parentSession ?? null,
        review.revision,
        review.sourceRevision,
        review.patch,
        review.files,
        review.createdAt,
        review.requiresSourceChecks,
      ]),
    );
  }
  private async rootClaimPath(root: string): Promise<string> {
    const common = realpathSync(
      resolve(
        root,
        (await this.git(root, ["rev-parse", "--git-common-dir"])).trim(),
      ),
    );
    const directory = join(common, "hades-integration-claims");
    if (
      existsSync(directory) &&
      (!lstatSync(directory).isDirectory() ||
        realpathSync(directory) !== directory)
    )
      throw new Error("Integration claim directory identity changed");
    return join(directory, digest(root) + ".claim");
  }
  /** Kernel-managed mutex protects compare-and-unlink against concurrent release/reacquisition. */
  private claimLock<T>(path: string, action: () => T): T {
    const lock = join(resolve(path, ".."), ".hades-claims.sqlite");
    try {
      const fd = openSync(lock, "wx", 0o600);
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!lstatSync(lock).isFile() || realpathSync(lock) !== lock)
      throw new Error("Integration claim mutex identity changed");
    const db = new DatabaseSync(lock);
    try {
      db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
      try {
        const result = action();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    } finally {
      db.close();
    }
  }
  private claim(path: string, claim: ApplyClaim): void {
    this.claimLock(path, () => {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(claim));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const dir = openSync(resolve(path, ".."), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    });
  }
  private release(path: string, claim: ApplyClaim): void {
    this.claimLock(path, () => {
      let current: ApplyClaim;
      try {
        current = JSON.parse(readFileSync(path, "utf8")) as ApplyClaim;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (
        current.token !== claim.token ||
        current.binding !== claim.binding ||
        current.root !== claim.root ||
        current.reviewId !== claim.reviewId ||
        current.patchHash !== claim.patchHash
      )
        throw new Error(
          "Integration claim ownership changed; inspect recovery",
        );
      unlinkSync(path);
      const dir = openSync(resolve(path, ".."), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    });
  }
  /** Release only a provably completed matching claim; never replays Git or certifies current source checks. */
  async reconcileApplied(
    id: string,
    scope: HelmIntegrationScope,
  ): Promise<HelmIntegrationReview> {
    let review = this.get(id, scope);
    if (review.status !== "applied")
      throw new Error(
        "Integration is not known applied; uncertain claim retained",
      );
    const rootPath = await this.rootClaimPath(review.root);
    review = this.get(id, scope);
    if (review.status !== "applied" || !Number.isFinite(review.appliedAt))
      throw new Error(
        "Integration is not known applied; uncertain claim retained",
      );
    const reviewPath = join(this.directory, id + ".apply-claim");
    if (!existsSync(reviewPath)) return review; // Legacy receipts confer no claim-release authority.
    const retained = JSON.parse(readFileSync(reviewPath, "utf8")) as ApplyClaim;
    if (
      typeof retained.token !== "string" ||
      !/^[a-f0-9-]{36}$/.test(retained.token) ||
      retained.reviewId !== id ||
      retained.root !== review.root ||
      retained.patchHash !== digest(review.patch) ||
      retained.binding !== this.binding(review)
    )
      throw new Error("Retained integration claim binding changed");
    if (existsSync(rootPath)) this.release(rootPath, retained);
    return review;
  }
  private async check(
    review: HelmIntegrationReview,
    apply = false,
    options: HelmIntegrationApplyOptions = {},
    dispatch?: () => void,
  ): Promise<void> {
    this.active(options);
    await this.supported(review.root, review.files);
    this.active(options);
    const file = join(this.directory, randomUUID() + ".patch");
    writeFileSync(file, review.patch, { mode: 0o600, flag: "wx" });
    let launched = false;
    try {
      this.active(options);
      if (apply) dispatch?.();
      launched = true;
      await this.git(
        review.root,
        [
          "apply",
          ...(apply ? [] : ["--check"]),
          "--whitespace=nowarn",
          "--",
          file,
        ],
        undefined,
        options.signal,
      );
    } catch (error) {
      if (!launched || (!apply && options.signal?.aborted)) throw error;
      throw new Error(
        apply
          ? "Integration outcome uncertain. Inspect source; do not retry this review."
          : "Source conflicts with the reviewed changes. Resolve separately and prepare a fresh review.",
        { cause: error },
      );
    } finally {
      unlinkSync(file);
    }
  }
  /** Exact displayed patch consent. Claims coordinate cooperating processes sharing the source Git directory; unrelated editors remain external actors. */
  async apply(
    id: string,
    scope: HelmIntegrationScope,
    reviewedPatchHash: string,
    options: HelmIntegrationApplyOptions = {},
  ): Promise<HelmIntegrationReview> {
    this.active(options);
    const root = realpathSync(scope.root),
      previous = queues.get(root) ?? Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        this.active(options);
        let review = this.get(id, scope);
        if (digest(review.patch) !== reviewedPatchHash)
          throw new Error("Reviewed patch changed");
        const reviewPath = join(this.directory, id + ".apply-claim");
        if (existsSync(reviewPath)) {
          const prior = JSON.parse(
            readFileSync(reviewPath, "utf8"),
          ) as ApplyClaim;
          if (
            prior.binding !== this.binding(review) ||
            prior.patchHash !== reviewedPatchHash ||
            prior.root !== root ||
            prior.reviewId !== id
          )
            throw new Error("Retained integration claim binding changed");
          if (review.status !== "applied")
            throw new Error(
              "Integration outcome uncertain. Inspect source; no apply was replayed.",
            );
        }
        if (review.status === "applied")
          return this.reconcileApplied(id, scope);
        if (review.status !== "prepared")
          throw new Error(
            "Integration outcome uncertain. Inspect source; do not retry this review.",
          );
        const run = this.host.get(review.runId);
        await this.supported(root);
        await this.supported(run.workspace);
        const diff = await this.host.diff(review.runId);
        if (
          run.status !== "verified" ||
          run.verificationRevision !== review.revision ||
          diff.revision !== review.revision ||
          diff.stale
        )
          throw new Error(
            "Task changed; verify again and prepare a fresh review",
          );
        if ((await this.source(root)) !== review.sourceRevision)
          throw new Error("Source changed; prepare a fresh review");
        await this.check(review, false, options);
        const rootPath = await this.rootClaimPath(root);
        this.active(options);
        mkdirSync(resolve(rootPath, ".."), { recursive: true, mode: 0o700 });
        if (realpathSync(resolve(rootPath, "..")) !== resolve(rootPath, ".."))
          throw new Error("Integration claim directory identity changed");
        const claim: ApplyClaim = {
          token: randomUUID(),
          reviewId: id,
          root,
          binding: this.binding(review),
          patchHash: reviewedPatchHash,
        };
        try {
          this.claim(rootPath, claim);
        } catch (error) {
          throw new Error(
            "Source integration is already claimed or uncertain. Inspect recovery; no apply was replayed.",
            { cause: error },
          );
        }
        let reviewClaimed = false,
          dispatched = false,
          applied = false;
        try {
          // Re-read after exclusive acquisition. Another process may have settled this review while this process validated.
          review = this.get(id, scope);
          if (this.binding(review) !== claim.binding)
            throw new Error("Reviewed integration body changed");
          if (review.status === "applied") return review;
          if (review.status !== "prepared")
            throw new Error("Integration outcome uncertain. Inspect recovery");
          this.claim(reviewPath, claim);
          reviewClaimed = true;
          this.active(options);
          this.scoped(this.host.get(review.runId), scope);
          await this.supported(run.workspace);
          if (
            (await this.host.diff(review.runId)).revision !== review.revision ||
            this.host.get(review.runId).status !== "verified"
          )
            throw new Error(
              "Task changed; verify again and prepare a fresh review",
            );
          if ((await this.source(root)) !== review.sourceRevision)
            throw new Error("Source changed; prepare a fresh review");
          if (this.binding(this.get(id, scope)) !== claim.binding)
            throw new Error("Reviewed integration body changed");
          this.active(options);
          review.status = "applying";
          this.save(review);
          await this.check(review, true, options, () => {
            this.active(options);
            const current = this.get(id, scope),
              currentRun = this.host.get(review.runId);
            if (
              this.binding(current) !== claim.binding ||
              current.status !== "applying"
            )
              throw new Error("Reviewed integration body changed");
            if (
              currentRun.status !== "verified" ||
              currentRun.verificationRevision !== review.revision
            )
              throw new Error("Task changed before integration");
            dispatched = true;
          });
          // Even a successful child result cannot assert active acceptance after cancellation.
          this.active(options);
          review.status = "applied";
          review.appliedAt = Date.now();
          this.save(review);
          applied = true;
          return review;
        } catch (error) {
          if (dispatched) {
            review.status = "unknown";
            this.save(review);
          } else if (reviewClaimed && review.status === "applying") {
            review.status = "prepared";
            this.save(review);
          }
          throw error;
        } finally {
          // A dispatched uncertain operation keeps both claims across crash/reopen.
          if (!dispatched || applied) {
            if (reviewClaimed && !applied) this.release(reviewPath, claim);
            this.release(rootPath, claim);
          }
        }
      });
    queues.set(root, work);
    try {
      return await work;
    } finally {
      if (queues.get(root) === work) queues.delete(root);
    }
  }
}
