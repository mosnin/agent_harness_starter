import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

type FileState = { content: string; mode: number; hash: string } | null;
interface Checkpoint {
  id: string;
  session: string;
  root: string;
  path: string;
  at: number;
  before: FileState;
  after?: FileState;
  restoredAt?: number;
}
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** A journal for individual approved file edits. Shell/MCP changes are not captured. */
export class Checkpoints {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private target(root: string, path: string) {
    root = realpathSync(root);
    const target = resolve(root, path),
      rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw new Error("Checkpoint path is outside the project");
    let current = root;
    for (const part of rel.split("/")) {
      current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new Error("Checkpoints do not follow symbolic links");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return target;
  }
  private state(path: string): FileState {
    if (!existsSync(path)) return null;
    const s = lstatSync(path);
    if (!s.isFile() || s.size > 2_000_000)
      throw new Error(
        "Checkpoint edits require a regular file of at most 2 MB",
      );
    const b = readFileSync(path);
    return {
      content: b.toString("base64"),
      mode: s.mode & 0o777,
      hash: hash(b),
    };
  }
  private save(c: Checkpoint) {
    const path = join(this.dir, c.id + ".json");
    writeFileSync(path + ".tmp", JSON.stringify(c), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  capture(root: string, path: string, session: string) {
    const target = this.target(root, path);
    const c: Checkpoint = {
      id: randomUUID(),
      session,
      root: realpathSync(root),
      path: relative(realpathSync(root), target),
      at: Date.now(),
      before: this.state(target),
    };
    this.save(c); // Persist before the mutation, including interrupted writes.
    return c;
  }
  finish(c: Checkpoint) {
    c.after = this.state(this.target(c.root, c.path));
    this.save(c);
  }
  private get(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error("Invalid checkpoint");
    return JSON.parse(
      readFileSync(join(this.dir, id + ".json"), "utf8"),
    ) as Checkpoint;
  }
  list(root: string, session?: string) {
    return readdirSync(this.dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => this.get(n.slice(0, -5)))
      .filter((c) => c.root === root && (!session || c.session === session))
      .sort((a, b) => b.at - a.at)
      .map(({ before, after, ...c }) => ({
        ...c,
        ready: after !== undefined,
        created: before === null,
        deleted: after === null,
      }));
  }
  inspect(id: string, root: string) {
    const c = this.get(id);
    if (c.root !== root)
      throw new Error("Checkpoint belongs to another project");
    const now = this.state(this.target(root, c.path));
    const conflict =
      c.after === undefined ||
      now?.hash !== c.after?.hash ||
      now?.mode !== c.after?.mode;
    return {
      ...c,
      before: c.before
        ? Buffer.from(c.before.content, "base64").toString("utf8")
        : null,
      after: c.after
        ? Buffer.from(c.after.content, "base64").toString("utf8")
        : null,
      conflict,
    };
  }
  restore(id: string, root: string) {
    const c = this.get(id);
    if (c.restoredAt)
      throw new Error("This checkpoint has already been restored");
    if (this.inspect(id, root).conflict)
      throw new Error(
        "File changed since this checkpoint. Keep your newer edits or restore the latest checkpoint first.",
      );
    const target = this.target(root, c.path);
    if (c.before) {
      mkdirSync(dirname(target), { recursive: true });
      const temporary = join(dirname(target), ".hades-restore-" + randomUUID());
      writeFileSync(temporary, Buffer.from(c.before.content, "base64"), {
        mode: c.before.mode,
        flag: "wx",
      });
      renameSync(temporary, target);
    } else if (existsSync(target)) unlinkSync(target);
    c.restoredAt = Date.now();
    this.save(c);
    return { restored: true, path: c.path };
  }
}
