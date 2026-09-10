/**
 * Tests for `scripts/build-sidecar.mjs` — the esbuild wrapper that bundles
 * `src/desktop/sidecar-entry.ts` into a plain Node script the native shell
 * (`src-tauri/src/main.rs`) spawns as the desktop app's sidecar process.
 *
 * These tests exercise the *real* esbuild bundler and, when it's available,
 * actually launch the produced file as a child process and talk to it over
 * stdio — the same way the Rust supervisor does — to prove the packaged
 * output is not just present but genuinely runnable.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSidecar, DEFAULT_OUTFILE } from "../../../scripts/build-sidecar.mjs";

let esbuildAvailable = true;
try {
  await import("esbuild");
} catch {
  esbuildAvailable = false;
}

const scratchDirs: string[] = [];

async function makeScratchDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildSidecar", () => {
  it("is exported as a function", () => {
    expect(typeof buildSidecar).toBe("function");
  });

  if (!esbuildAvailable) {
    // esbuild is a devDependency, not a hard runtime dependency — this
    // environment doesn't have it installed. Confirm the module still
    // loads cleanly (no top-level crash from an eager `require("esbuild")`)
    // and reports the documented default output location, without ever
    // touching the real esbuild API.
    it("esbuild is not installed: reports the documented default outfile without crashing", async () => {
      expect(DEFAULT_OUTFILE.endsWith(path.join("dist", "desktop", "sidecar-entry.js"))).toBe(true);

      const result = await buildSidecar();
      expect(result.skipped).toBe(true);
      expect(result.outfile).toBe(DEFAULT_OUTFILE);
    });
  } else {
    it(
      "bundles sidecar-entry.ts into a single, non-trivial, shebang-prefixed JS file",
      async () => {
        const dir = await makeScratchDir("hades-sidecar-build-");
        const outfile = path.join(dir, "sidecar-entry.js");

        const result = await buildSidecar({ outfile });
        expect(result.skipped).toBe(false);
        expect(result.outfile).toBe(outfile);

        const stat = await fs.stat(outfile);
        expect(stat.isFile()).toBe(true);
        // A real bundle of sidecar-entry.ts plus its internal src/ dependency
        // graph (ipc/contract, core/sidecar, the swarm-runtime engine it
        // wires up) is tens of kilobytes; a stub or empty file would not be.
        expect(stat.size).toBeGreaterThan(10_000);

        const contents = await fs.readFile(outfile, "utf8");
        expect(contents.startsWith("#!/usr/bin/env node\n")).toBe(true);
        // Exactly one shebang line — esbuild preserves the entry source's own
        // shebang verbatim, so a naively-added banner would double it up into
        // invalid JS (`#!/usr/bin/env node` appearing twice at the top).
        expect(contents.match(/^#!\/usr\/bin\/env node$/gm)?.length).toBe(1);
      },
      30_000
    );

    it(
      "runs the built sidecar end to end: a runtime.stop command on stdin yields a valid AppEvent line and a clean exit",
      async () => {
        const dir = await makeScratchDir("hades-sidecar-run-");
        const outfile = path.join(dir, "sidecar-entry.js");
        await buildSidecar({ outfile });

        const { stdout, exitCode } = await new Promise<{ stdout: string; exitCode: number | null }>(
          (resolve, reject) => {
            const child = spawn(process.execPath, [outfile], { stdio: ["pipe", "pipe", "pipe"] });
            let out = "";
            let errOut = "";
            const timer = setTimeout(() => {
              child.kill();
              reject(new Error(`sidecar did not exit in time; stderr so far: ${errOut}`));
            }, 15_000);

            child.stdout.on("data", (chunk: Buffer) => {
              out += chunk.toString("utf8");
            });
            child.stderr.on("data", (chunk: Buffer) => {
              errOut += chunk.toString("utf8");
            });
            child.on("error", (err) => {
              clearTimeout(timer);
              reject(err);
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              resolve({ stdout: out, exitCode: code });
            });

            // One line, exactly the shape the Tauri renderer would send: the
            // desktop IPC contract's `runtime.stop` Command, newline-delimited.
            child.stdin.write('{"kind":"runtime.stop"}\n');
            child.stdin.end();
          }
        );

        // Did not crash: a clean exit code, not a thrown/uncaught error.
        expect(exitCode).toBe(0);

        const lines = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        expect(lines.length).toBeGreaterThan(0);

        // Every emitted line must be valid JSON decoding to an AppEvent-shaped
        // object (has a string `kind`) — the packaged sidecar speaking the
        // same wire format the source module promises, not raw source or a
        // stack trace leaking onto stdout.
        const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        for (const event of events) {
          expect(typeof event).toBe("object");
          expect(typeof event.kind).toBe("string");
        }

        // runtime.stop with no runtime ever started is a no-op close plus a
        // runtime.status(running:false) — see Sidecar.onStop in
        // src/desktop/core/sidecar.ts. A "log" line is also an acceptable
        // signal that the process handled the command without crashing.
        expect(events.some((e) => e.kind === "runtime.status" || e.kind === "log")).toBe(true);
      },
      30_000
    );
  }
});
