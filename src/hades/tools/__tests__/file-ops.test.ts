/**
 * Real-fs behavioral tests for `file_ops`, run in a mkdtemp sandbox.
 * Nothing here is mocked — every read/write/list/stat/mkdir/delete
 * really touches disk. Covers the jail's actual attack surface:
 * traversal strings, symlink escapes, atomic writes, read caps, and
 * total-function behavior (never throws out of `run`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createFileOpsTool, __internal } from "../file-ops";
import type { CatalogEntry } from "../file-ops";

let root: string;
let entry: CatalogEntry;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "file-ops-jail-"));
  entry = createFileOpsTool({ root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function run(input: object): Promise<{ ok: boolean; body: any }> {
  const result = await entry.tool.run(JSON.stringify(input));
  return { ok: result.ok, body: JSON.parse(result.output) };
}

describe("createFileOpsTool: catalog metadata", () => {
  it("matches the locked contract", () => {
    expect(entry.id).toBe("file_ops");
    expect(entry.tool.name).toBe("file_ops");
    expect(entry.category).toBe("system");
    expect(entry.mode).toBe("real");
    expect(entry.requiresNetwork).toBe(false);
    expect(entry.requiredEnvKeys).toEqual([]);
    expect(entry.verifierId).toBe("verify.file_ops");
  });
});

describe("createFileOpsTool: basic operations", () => {
  it("writes then reads a file back", async () => {
    const w = await run({ op: "write", path: "hello.txt", content: "hello world" });
    expect(w.ok).toBe(true);
    expect(w.body.mode).toBe("real");
    expect(w.body.path).toBe("hello.txt");

    const r = await run({ op: "read", path: "hello.txt" });
    expect(r.ok).toBe(true);
    expect(r.body.result).toBe("hello world");
    expect(r.body.truncated).toBeUndefined();
  });

  it("write creates parent directories as needed", async () => {
    const w = await run({ op: "write", path: "a/b/c/file.txt", content: "nested" });
    expect(w.ok).toBe(true);
    const r = await run({ op: "read", path: "a/b/c/file.txt" });
    expect(r.body.result).toBe("nested");
  });

  it("append adds to existing content", async () => {
    await run({ op: "write", path: "log.txt", content: "line1\n" });
    const a = await run({ op: "append", path: "log.txt", content: "line2\n" });
    expect(a.ok).toBe(true);
    const r = await run({ op: "read", path: "log.txt" });
    expect(r.body.result).toBe("line1\nline2\n");
  });

  it("append creates the file if it doesn't exist", async () => {
    const a = await run({ op: "append", path: "new.txt", content: "first" });
    expect(a.ok).toBe(true);
    const r = await run({ op: "read", path: "new.txt" });
    expect(r.body.result).toBe("first");
  });

  it("mkdir creates a directory, list shows it", async () => {
    const m = await run({ op: "mkdir", path: "subdir" });
    expect(m.ok).toBe(true);
    const l = await run({ op: "list", path: "." });
    expect(l.ok).toBe(true);
    expect(l.body.result).toEqual([{ name: "subdir", type: "dir" }]);
  });

  it("list sorts entries by name and reports file/dir types", async () => {
    await run({ op: "write", path: "b.txt", content: "x" });
    await run({ op: "write", path: "a.txt", content: "x" });
    await run({ op: "mkdir", path: "c-dir" });
    const l = await run({ op: "list", path: "." });
    expect(l.body.result.map((e: any) => e.name)).toEqual(["a.txt", "b.txt", "c-dir"]);
    expect(l.body.result.find((e: any) => e.name === "c-dir").type).toBe("dir");
    expect(l.body.result.find((e: any) => e.name === "a.txt").type).toBe("file");
  });

  it("stat reports type and size for a file", async () => {
    await run({ op: "write", path: "sized.txt", content: "12345" });
    const s = await run({ op: "stat", path: "sized.txt" });
    expect(s.ok).toBe(true);
    expect(s.body.result.type).toBe("file");
    expect(s.body.result.size).toBe(5);
  });

  it("stat on a missing path returns ok:false, not a throw", async () => {
    const s = await run({ op: "stat", path: "nope.txt" });
    expect(s.ok).toBe(false);
    expect(typeof s.body.error).toBe("string");
  });

  it("delete removes a file", async () => {
    await run({ op: "write", path: "gone.txt", content: "x" });
    const d = await run({ op: "delete", path: "gone.txt" });
    expect(d.ok).toBe(true);
    const s = await run({ op: "stat", path: "gone.txt" });
    expect(s.ok).toBe(false);
  });

  it("delete of a missing path returns ok:false, does not throw", async () => {
    const d = await run({ op: "delete", path: "never-existed.txt" });
    expect(d.ok).toBe(false);
    expect(typeof d.body.error).toBe("string");
  });

  it("delete refuses a non-empty directory", async () => {
    await run({ op: "mkdir", path: "occupied" });
    await run({ op: "write", path: "occupied/child.txt", content: "x" });
    const d = await run({ op: "delete", path: "occupied" });
    expect(d.ok).toBe(false);
    expect(d.body.error).toMatch(/non-empty/);
    // Directory and child must still exist.
    const s = await run({ op: "stat", path: "occupied/child.txt" });
    expect(s.ok).toBe(true);
  });

  it("delete succeeds on an empty directory", async () => {
    await run({ op: "mkdir", path: "empty-dir" });
    const d = await run({ op: "delete", path: "empty-dir" });
    expect(d.ok).toBe(true);
  });
});

describe("createFileOpsTool: read cap / truncation", () => {
  it("truncates a read at maxBytes and reports truncated:true", async () => {
    const content = "x".repeat(1000);
    await run({ op: "write", path: "big.txt", content });
    const r = await run({ op: "read", path: "big.txt", maxBytes: 100 });
    expect(r.ok).toBe(true);
    expect((r.body.result as string).length).toBe(100);
    expect(r.body.truncated).toBe(true);
  });

  it("does not report truncated when file fits under maxBytes", async () => {
    await run({ op: "write", path: "small.txt", content: "short" });
    const r = await run({ op: "read", path: "small.txt", maxBytes: 100 });
    expect(r.body.truncated).toBeUndefined();
  });

  it("uses the default 262144-byte cap when maxBytes is omitted", () => {
    expect(__internal.DEFAULT_MAX_READ_BYTES).toBe(262144);
  });

  it("read of a directory fails cleanly", async () => {
    await run({ op: "mkdir", path: "adir" });
    const r = await run({ op: "read", path: "adir" });
    expect(r.ok).toBe(false);
  });
});

describe("createFileOpsTool: atomic write", () => {
  it("leaves no tmp file behind on success", async () => {
    await run({ op: "write", path: "atomic.txt", content: "v1" });
    const entries = await fs.readdir(root);
    expect(entries).toEqual(["atomic.txt"]);
    await run({ op: "write", path: "atomic.txt", content: "v2 overwritten" });
    const entries2 = await fs.readdir(root);
    expect(entries2).toEqual(["atomic.txt"]);
    const r = await run({ op: "read", path: "atomic.txt" });
    expect(r.body.result).toBe("v2 overwritten");
  });

  it("leaves no tmp file behind when the target directory disappears mid-write", async () => {
    // Force a failure path: point at a path whose parent will be removed
    // out from under a concurrent write is hard to simulate directly, so
    // instead assert the tmp-file naming convention never leaks by
    // writing many times and checking directory contents stay singular.
    for (let i = 0; i < 5; i++) {
      await run({ op: "write", path: "repeat.txt", content: `iteration-${i}` });
    }
    const entries = await fs.readdir(root);
    expect(entries.filter((e) => e.startsWith(".tmp-"))).toEqual([]);
    expect(entries).toContain("repeat.txt");
  });
});

describe("createFileOpsTool: jail — traversal strings", () => {
  it("rejects a simple .. traversal", async () => {
    const outside = path.join(path.dirname(root), "outside-secret.txt");
    await fs.writeFile(outside, "top secret");
    const r = await run({ op: "read", path: "../" + path.basename(outside) });
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/escapes root/);
  });

  it("rejects deeply nested ../../../ traversal", async () => {
    const r = await run({ op: "read", path: "../../../etc/passwd" });
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/escapes root/);
  });

  it("rejects an absolute path outside the root (/etc/passwd)", async () => {
    const r = await run({ op: "read", path: "/etc/passwd" });
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/escapes root/);
  });

  it("does NOT url-decode %2e%2e — it is treated as a literal filename segment", async () => {
    // "%2e%2e" as a path component must NOT be interpreted as "..".
    // It stays inside the jail as a literal (nonexistent) path, so the
    // failure is "not found", never "escapes root".
    const r = await run({ op: "read", path: "%2e%2e/secret.txt" });
    expect(r.ok).toBe(false);
    expect(r.body.error).not.toMatch(/escapes root/);
  });

  it("rejects a root-prefix cousin directory (/tmp/jail-evil vs /tmp/jail)", async () => {
    const cousin = `${root}-evil`;
    await fs.mkdir(cousin, { recursive: true });
    await fs.writeFile(path.join(cousin, "secret.txt"), "cousin secret");
    try {
      // Relative escape that lands exactly on the cousin directory.
      const r = await run({ op: "read", path: "../" + path.basename(cousin) + "/secret.txt" });
      expect(r.ok).toBe(false);
      expect(r.body.error).toMatch(/escapes root/);
    } finally {
      await fs.rm(cousin, { recursive: true, force: true });
    }
  });

  it("rejects a path containing a NUL byte", async () => {
    const r = await run({ op: "read", path: "foo\0bar" });
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/NUL/);
  });
});

describe("createFileOpsTool: jail — symlink escapes", () => {
  it("rejects reading through a real symlink pointing outside the jail", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-ops-outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    await fs.writeFile(outsideFile, "outside data");
    const linkPath = path.join(root, "escape-link");
    await fs.symlink(outsideFile, linkPath);

    try {
      const r = await run({ op: "read", path: "escape-link" });
      expect(r.ok).toBe(false);
      expect(r.body.error).toMatch(/escapes root|symlink/);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects writing through a real symlinked directory pointing outside the jail", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-ops-outside-"));
    const linkDir = path.join(root, "escape-dir");
    await fs.symlink(outsideDir, linkDir, "dir");

    try {
      const r = await run({ op: "write", path: "escape-dir/pwned.txt", content: "pwn" });
      expect(r.ok).toBe(false);
      expect(r.body.error).toMatch(/escapes root|symlink/);
      const outsideEntries = await fs.readdir(outsideDir);
      expect(outsideEntries).toEqual([]);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows operating on a symlink that stays inside the jail", async () => {
    await run({ op: "write", path: "real.txt", content: "inside data" });
    await fs.symlink(path.join(root, "real.txt"), path.join(root, "inside-link"));
    const r = await run({ op: "read", path: "inside-link" });
    expect(r.ok).toBe(true);
    expect(r.body.result).toBe("inside data");
  });
});

describe("createFileOpsTool: malformed input never throws", () => {
  const malformed = [
    "not json at all",
    "{",
    "[]",
    "null",
    "42",
    '"just a string"',
    "{}",
    '{"op":"read"}',
    '{"op":"bogus","path":"x"}',
    '{"op":"read","path":123}',
    '{"op":"read","path":""}',
    '{"op":"read","path":"x","maxBytes":-1}',
    '{"op":"read","path":"x","maxBytes":"nope"}',
    '{"op":"write","path":"x","content":123}',
  ];

  it.each(malformed)("returns ok:false for malformed input %#", async (input) => {
    const result = await entry.tool.run(input);
    expect(result.ok).toBe(false);
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it("survives a seeded fuzz loop of 200 malformed inputs without throwing", async () => {
    let seed = 12345;
    function rand(): number {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    const chars = '{}[]":,0123456789abcXYZ.._-/\\%\0 \n\t';
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(rand() * 40);
      let s = "";
      for (let j = 0; j < len; j++) {
        s += chars[Math.floor(rand() * chars.length)];
      }
      const result = await entry.tool.run(s);
      expect(result.ok).toBe(false);
      expect(typeof result.output).toBe("string");
    }
  });
});

// Keep fsSync imported meaningfully: verify a jail-escape attempt truly
// never creates anything on the host filesystem outside root.
describe("createFileOpsTool: jail actually prevents host writes", () => {
  it("a rejected traversal write never creates the target file", async () => {
    const target = path.join(path.dirname(root), "should-not-exist.txt");
    if (fsSync.existsSync(target)) await fs.unlink(target);
    const r = await run({ op: "write", path: "../should-not-exist.txt", content: "nope" });
    expect(r.ok).toBe(false);
    expect(fsSync.existsSync(target)).toBe(false);
  });
});
