/* ------------------------------------------------------------------ *
 * browser-command.test.ts
 *
 * REAL-VS-MOCK POLICY for this file: `browser-command.ts` is a thin
 * argv-parsing / dispatch / exit-code / stdout-stderr layer over an
 * INJECTED `BrowserCliDeps` seam — it never touches a real browser, a
 * real network, or the filesystem itself. These tests use fully
 * injected fake `deps` (pure unit tests of parsing/dispatch/formatting)
 * — mocking the seam is the honest choice here, since the point of
 * this file is dispatch correctness, not browsing behavior. The real
 * end-to-end browsing checkpoint is proven separately, with a real
 * browser and a real server, in `browse-bench.test.ts`.
 * ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import {
  buildBrowserCommand,
  type BrowserCliDeps,
  type BrowserBenchReportLike,
  type BrowserProbeResult,
  type BrowserOpenRequest,
} from "../browser-command";

function makeDeps(overrides: Partial<BrowserCliDeps> = {}): { deps: BrowserCliDeps; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: BrowserCliDeps = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    browse: async (_req: BrowserOpenRequest) => ({ ok: true, output: "default-open-output" }),
    bench: async () => makeBenchReport(),
    probe: () => ({ chromiumFound: true, chromiumPath: "/opt/pw-browsers/chromium/chrome", headedOk: false, reason: "no display" }),
    ...overrides,
  };
  return { deps, stdout, stderr };
}

function makeBenchReport(overrides: Partial<BrowserBenchReportLike> = {}): BrowserBenchReportLike {
  return {
    ok: true,
    chromium: { found: true, path: "/opt/pw-browsers/chromium/chrome" },
    pagesVisited: 4,
    linksFollowed: 1,
    passages: 6,
    citedAll: true,
    traceVerified: true,
    traceRoot: "a".repeat(64),
    eventCount: 6,
    elapsedMs: 1234,
    failures: [],
    ...overrides,
  };
}

// ===========================================================================
// name / description / shape
// ===========================================================================

describe("buildBrowserCommand — shape", () => {
  it("exposes the locked name/description/run shape", () => {
    const { deps } = makeDeps();
    const cmd = buildBrowserCommand(deps);
    expect(cmd.name).toBe("browser");
    expect(typeof cmd.description).toBe("string");
    expect(cmd.description.length).toBeGreaterThan(0);
    expect(typeof cmd.run).toBe("function");
  });
});

// ===========================================================================
// help / no-args / unknown subcommand
// ===========================================================================

describe("help / no-args / unknown subcommand", () => {
  it.each([[[]], [["help"]], [["--help"]], [["-h"]]])("argv %j -> usage on stderr, nothing on stdout, exit 2", async (argv) => {
    const { deps, stdout, stderr } = makeDeps();
    const code = await buildBrowserCommand(deps).run(argv);
    expect(code).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: hades browser <command>");
  });

  it("unknown subcommand -> usage on stderr, exit 2", async () => {
    const { deps, stderr } = makeDeps();
    const code = await buildBrowserCommand(deps).run(["frobnicate"]);
    expect(code).toBe(2);
    expect(stderr[0]).toContain("Unknown browser command: frobnicate");
    expect(stderr.join("\n")).toContain("Usage: hades browser <command>");
  });

  it.each([
    ["opne", "open"],
    ["bnech", "bench"],
    ["prob", "probe"],
  ])("typo %j suggests %j in the usage error", async (typo, suggestion) => {
    const { deps, stderr } = makeDeps();
    const code = await buildBrowserCommand(deps).run([typo]);
    expect(code).toBe(2);
    expect(stderr[0]).toContain(`did you mean "${suggestion}"?`);
  });

  it("a wildly different unknown subcommand gets no suggestion", async () => {
    const { deps, stderr } = makeDeps();
    await buildBrowserCommand(deps).run(["zzzzzzzzzzzzzzzz"]);
    expect(stderr[0]).not.toContain("did you mean");
  });
});

// ===========================================================================
// `open` — argv parsing table
// ===========================================================================

describe("browser open — argv parsing", () => {
  const table: Array<{ name: string; argv: string[]; expectCode: number; stderrContains?: string }> = [
    { name: "valid url only", argv: ["open", "http://127.0.0.1:9/"], expectCode: 0 },
    { name: "valid url + --json", argv: ["open", "http://127.0.0.1:9/", "--json"], expectCode: 0 },
    { name: "valid url + --max-bytes", argv: ["open", "http://127.0.0.1:9/", "--max-bytes", "1024"], expectCode: 0 },
    { name: "flags before url", argv: ["open", "--json", "--max-bytes", "10", "http://127.0.0.1:9/"], expectCode: 0 },
    { name: "missing url", argv: ["open"], expectCode: 2, stderrContains: "missing <url>" },
    { name: "missing url, only flags", argv: ["open", "--json"], expectCode: 2, stderrContains: "missing <url>" },
    { name: "--max-bytes non-numeric", argv: ["open", "u", "--max-bytes", "abc"], expectCode: 2, stderrContains: "--max-bytes must be a positive integer" },
    { name: "--max-bytes zero", argv: ["open", "u", "--max-bytes", "0"], expectCode: 2, stderrContains: "--max-bytes must be a positive integer" },
    { name: "--max-bytes negative", argv: ["open", "u", "--max-bytes", "-5"], expectCode: 2, stderrContains: "--max-bytes must be a positive integer" },
    { name: "--max-bytes fractional", argv: ["open", "u", "--max-bytes", "1.5"], expectCode: 2, stderrContains: "--max-bytes must be a positive integer" },
    { name: "--max-bytes missing value", argv: ["open", "u", "--max-bytes"], expectCode: 2, stderrContains: "--max-bytes requires a value" },
    { name: "unknown flag", argv: ["open", "u", "--bogus"], expectCode: 2, stderrContains: "unknown flag: --bogus" },
    { name: "two positional args", argv: ["open", "u1", "u2"], expectCode: 2, stderrContains: "unexpected extra argument: u2" },
  ];

  it.each(table.map((t) => [t.name, t] as const))("%s", async (_name, t) => {
    const { deps, stderr } = makeDeps();
    const code = await buildBrowserCommand(deps).run(t.argv);
    expect(code).toBe(t.expectCode);
    if (t.stderrContains) {
      expect(stderr.join("\n")).toContain(t.stderrContains);
      expect(stderr.join("\n")).toContain("Usage: hades browser <command>");
    }
  });

  it("passes the parsed url and maxBytes through to deps.browse", async () => {
    let received: BrowserOpenRequest | undefined;
    const { deps } = makeDeps({
      browse: async (req) => {
        received = req;
        return { ok: true, output: "ok" };
      },
    });
    await buildBrowserCommand(deps).run(["open", "http://127.0.0.1:9/page", "--max-bytes", "500"]);
    expect(received).toEqual({ url: "http://127.0.0.1:9/page", maxBytes: 500 });
  });

  it("omits maxBytes from the request when --max-bytes was not given", async () => {
    let received: BrowserOpenRequest | undefined;
    const { deps } = makeDeps({
      browse: async (req) => {
        received = req;
        return { ok: true, output: "ok" };
      },
    });
    await buildBrowserCommand(deps).run(["open", "http://127.0.0.1:9/page"]);
    expect(received).toEqual({ url: "http://127.0.0.1:9/page" });
    expect(received && "maxBytes" in received).toBe(false);
  });
});

// ===========================================================================
// `open` — exit codes and output
// ===========================================================================

describe("browser open — exit codes and output", () => {
  it("ok:true -> exit 0, prints output to stdout", async () => {
    const { deps, stdout } = makeDeps({ browse: async () => ({ ok: true, output: "<html>hello</html>" }) });
    const code = await buildBrowserCommand(deps).run(["open", "http://127.0.0.1:9/"]);
    expect(code).toBe(0);
    expect(stdout).toEqual(["<html>hello</html>"]);
  });

  it("ok:false -> exit 1, still prints the tool output", async () => {
    const { deps, stdout } = makeDeps({ browse: async () => ({ ok: false, output: "error: blocked host" }) });
    const code = await buildBrowserCommand(deps).run(["open", "http://blocked.example/"]);
    expect(code).toBe(1);
    expect(stdout).toEqual(["error: blocked host"]);
  });

  it("--json prints a stable-keyed, exact JSON line for ok:true", async () => {
    const { deps, stdout } = makeDeps({ browse: async () => ({ ok: true, output: "hi" }) });
    const code = await buildBrowserCommand(deps).run(["open", "http://127.0.0.1:9/", "--json"]);
    expect(code).toBe(0);
    expect(stdout).toEqual([JSON.stringify({ ok: true, output: "hi" })]);
    expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, output: "hi" });
  });

  it("deps.browse rejecting maps to exit 1, error on stderr, command never throws", async () => {
    const { deps, stdout, stderr } = makeDeps({
      browse: async () => {
        throw new Error("network died");
      },
    });
    let code: number | undefined;
    await expect(
      (async () => {
        code = await buildBrowserCommand(deps).run(["open", "http://127.0.0.1:9/"]);
      })(),
    ).resolves.not.toThrow();
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr[0]).toContain("network died");
  });

  it("deps.browse throwing a non-Error value is still mapped to exit 1 with a stderr message", async () => {
    const { deps, stderr } = makeDeps({
      browse: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw string failure";
      },
    });
    const code = await buildBrowserCommand(deps).run(["open", "http://127.0.0.1:9/"]);
    expect(code).toBe(1);
    expect(stderr[0]).toContain("raw string failure");
  });
});

// ===========================================================================
// `bench`
// ===========================================================================

describe("browser bench", () => {
  it("report.ok:true -> exit 0, human output lists every measured field", async () => {
    const { deps, stdout } = makeDeps({ bench: async () => makeBenchReport() });
    const code = await buildBrowserCommand(deps).run(["bench"]);
    expect(code).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("browse-bench: PASS");
    expect(out).toContain("pages visited:   4");
    expect(out).toContain("links followed:  1");
    expect(out).toContain("passages:        6");
    expect(out).toContain("trace root:      " + "a".repeat(64));
    expect(out).toContain("failures:        none");
  });

  it("report.ok:false -> exit 1, human output lists every failure line", async () => {
    const { deps, stdout } = makeDeps({
      bench: async () => makeBenchReport({ ok: false, citedAll: false, failures: ["no-passages-extracted: http://x/y"] }),
    });
    const code = await buildBrowserCommand(deps).run(["bench"]);
    expect(code).toBe(1);
    const out = stdout.join("\n");
    expect(out).toContain("browse-bench: FAIL");
    expect(out).toContain("    - no-passages-extracted: http://x/y");
  });

  it("--json prints exact, stable-keyed JSON matching the report", async () => {
    const report = makeBenchReport();
    const { deps, stdout } = makeDeps({ bench: async () => report });
    const code = await buildBrowserCommand(deps).run(["bench", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout[0]!);
    expect(Object.keys(parsed)).toEqual([
      "ok",
      "chromium",
      "pagesVisited",
      "linksFollowed",
      "passages",
      "citedAll",
      "traceVerified",
      "traceRoot",
      "eventCount",
      "elapsedMs",
      "failures",
    ]);
    expect(parsed).toMatchObject({ ok: true, pagesVisited: 4, passages: 6, traceRoot: "a".repeat(64) });
  });

  it("--json renders a missing chromium.path as null (not omitted, not undefined)", async () => {
    const { deps, stdout } = makeDeps({
      bench: async () => makeBenchReport({ chromium: { found: false } }),
    });
    await buildBrowserCommand(deps).run(["bench", "--json"]);
    const parsed = JSON.parse(stdout[0]!);
    expect(parsed.chromium).toEqual({ found: false, path: null });
  });

  it("unknown flag -> exit 2, usage on stderr", async () => {
    const { deps, stderr } = makeDeps();
    const code = await buildBrowserCommand(deps).run(["bench", "--bogus"]);
    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("unknown flag: --bogus");
  });

  it("deps.bench rejecting maps to exit 1, error on stderr, command never throws", async () => {
    const { deps, stderr } = makeDeps({
      bench: async () => {
        throw new Error("chromium crashed mid-bench");
      },
    });
    const code = await buildBrowserCommand(deps).run(["bench"]);
    expect(code).toBe(1);
    expect(stderr[0]).toContain("chromium crashed mid-bench");
  });
});

// ===========================================================================
// `probe`
// ===========================================================================

describe("browser probe", () => {
  it("always exits 0 even when chromium is not found and headed is unavailable", async () => {
    const { deps, stdout } = makeDeps({ probe: () => ({ chromiumFound: false, headedOk: false, reason: "no browsers installed" }) });
    const code = await buildBrowserCommand(deps).run(["probe"]);
    expect(code).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("chromium:        NOT FOUND");
    expect(out).toContain("headed display:  unavailable (no browsers installed)");
  });

  it("always exits 0 when chromium and headed display are both available", async () => {
    const { deps, stdout } = makeDeps({ probe: () => ({ chromiumFound: true, chromiumPath: "/x/chrome", headedOk: true }) });
    const code = await buildBrowserCommand(deps).run(["probe"]);
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("chromium:        found (/x/chrome)");
    expect(stdout.join("\n")).toContain("headed display:  available");
  });

  it("--json prints exact, stable-keyed JSON with null for absent optional fields", async () => {
    const { deps, stdout } = makeDeps({ probe: () => ({ chromiumFound: true, chromiumPath: "/x/chrome", headedOk: false, reason: "no display" }) });
    const code = await buildBrowserCommand(deps).run(["probe", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual({ chromiumFound: true, chromiumPath: "/x/chrome", headedOk: false, reason: "no display" });
  });

  it("--json omits-as-null both chromiumPath and reason when neither is present", async () => {
    const { deps, stdout } = makeDeps({ probe: () => ({ chromiumFound: false, headedOk: false }) });
    await buildBrowserCommand(deps).run(["probe", "--json"]);
    expect(JSON.parse(stdout[0]!)).toEqual({ chromiumFound: false, chromiumPath: null, headedOk: false, reason: null });
  });

  it("unknown flag -> exit 2, usage on stderr", async () => {
    const { deps, stderr } = makeDeps();
    const code = await buildBrowserCommand(deps).run(["probe", "--bogus"]);
    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("unknown flag: --bogus");
  });

  it("deps.probe throwing synchronously is still mapped to a non-throwing result with stderr output", async () => {
    const { deps, stderr } = makeDeps({
      probe: () => {
        throw new Error("probe blew up");
      },
    });
    let code: number | undefined;
    await expect(
      (async () => {
        code = await buildBrowserCommand(deps).run(["probe"]);
      })(),
    ).resolves.not.toThrow();
    expect(code).toBe(1);
    expect(stderr[0]).toContain("probe blew up");
  });
});

// ===========================================================================
// Cross-cutting: no path ever throws out of run()
// ===========================================================================

describe("run() never throws", () => {
  const argvs = [[], ["help"], ["bogus"], ["open"], ["open", "u", "--bogus"], ["bench"], ["bench", "--bogus"], ["probe"], ["probe", "--bogus"]];

  it.each(argvs.map((a) => [a] as const))("argv %j resolves rather than rejecting", async (argv) => {
    const { deps } = makeDeps();
    await expect(buildBrowserCommand(deps).run(argv)).resolves.toEqual(expect.any(Number));
  });
});
