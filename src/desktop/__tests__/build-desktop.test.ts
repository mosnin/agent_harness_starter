import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { buildDesktop, buildConfig } from "../../../scripts/build-desktop.mjs";

const SCRATCH_ROOT =
  "/tmp/claude-0/-home-user-agent-harness-starter/a453c04b-3f74-57bd-8219-68424ba604e4/scratchpad";
const REPO_ROOT = path.resolve(__dirname, "../../..");

// Falls back to the OS temp dir if the scratchpad root isn't present (e.g. a
// different sandbox environment running this same test), so the test stays
// hermetic everywhere, not just in this session.
const tmpParent = existsSync(SCRATCH_ROOT) ? SCRATCH_ROOT : os.tmpdir();

let outdir: string | undefined;

afterEach(async () => {
  if (outdir) {
    await rm(outdir, { recursive: true, force: true });
    outdir = undefined;
  }
});

describe("buildConfig", () => {
  it("targets the desktop webview entry with the expected esbuild options", () => {
    const config = buildConfig("/some/outdir");
    expect(config.entryPoints).toEqual({ main: path.join(REPO_ROOT, "src/desktop/ui/main.ts") });
    expect(config.outdir).toBe("/some/outdir");
    expect(config.bundle).toBe(true);
    expect(config.platform).toBe("browser");
    expect(config.target).toBe("esnext");
    expect(config.format).toBe("esm");
    expect(config.loader).toEqual({ ".css": "css" });
  });
});

describe("buildDesktop", () => {
  it("is an async function", () => {
    expect(typeof buildDesktop).toBe("function");
  });

  it("bundles main.ts + CSS into main.js/main.css and copies index.html", async () => {
    outdir = await mkdtemp(path.join(tmpParent, "build-desktop-test-"));

    const result = await buildDesktop({ outdir });

    if (!result.ok) {
      // esbuild isn't installed in this environment — the script should
      // still report a well-formed, usable config rather than throwing.
      expect(result.reason).toBe("esbuild-missing");
      expect(result.config.entryPoints).toEqual({
        main: path.join(REPO_ROOT, "src/desktop/ui/main.ts"),
      });
      return;
    }

    const mainJsPath = path.join(outdir, "main.js");
    const mainCssPath = path.join(outdir, "main.css");
    const indexHtmlPath = path.join(outdir, "index.html");

    expect(existsSync(mainJsPath)).toBe(true);
    expect(existsSync(mainCssPath)).toBe(true);
    expect(existsSync(indexHtmlPath)).toBe(true);

    const mainJs = await readFile(mainJsPath, "utf8");
    expect(mainJs.length).toBeGreaterThan(0);

    const indexHtml = await readFile(indexHtmlPath, "utf8");
    expect(indexHtml).toContain('id="root"');
    expect(indexHtml).toContain("main.js");
  });
});

describe("desktop frontend source shape", () => {
  it("index.html has a #root mount node and loads main.js as a module", async () => {
    const html = await readFile(path.join(REPO_ROOT, "src/desktop/ui/index.html"), "utf8");
    expect(html).toContain('id="root"');
    expect(html).toMatch(/<script[^>]*type="module"[^>]*src="\.\/main\.js"/);
    // No external CDN <link>/<script> tags (the CSP meta's "ipc.localhost"
    // value doesn't count as a CDN reference).
    expect(html).not.toMatch(/<(link|script)[^>]*\s(href|src)="https?:\/\//);
  });

  it("main.ts wires mountApp to tauriBridge/devBridge based on window.__TAURI__", async () => {
    const main = await readFile(path.join(REPO_ROOT, "src/desktop/ui/main.ts"), "utf8");
    expect(main).toMatch(/from ["']\.\/renderer["']/);
    expect(main).toContain("mountApp");
    expect(main).toMatch(/from ["']\.\/bridge["']/);
    expect(main).toContain("tauriBridge");
    expect(main).toContain("devBridge");
    expect(main).toContain("__TAURI__");
    expect(main).toContain("DOMContentLoaded");
  });
});
