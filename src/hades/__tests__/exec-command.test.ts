/**
 * Integration tests for `hades exec` — the CLI surface of the Phase 1
 * programmatic-tool-calling stack — plus the central `execEnabledRegistry`
 * wiring helper.
 *
 * REAL vs MOCK: nothing here is mocked. Every `exec run` test spawns the
 * real worker_threads JS sandbox (or the real python3 subprocess), drives
 * the real Tool-RPC bridge against the real builtin tools, and re-verifies
 * the real hash-chained provenance ledger. The bench test runs the real
 * pipeline bench end to end (whose only internal mock is its clearly
 * labelled scripted LLM on the ReAct side).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExecCommand } from "../cli/exec-command";
import { HadesCli } from "../cli/cli";
import { execEnabledRegistry } from "../exec/index";
import { isPythonAvailable } from "../exec/sandbox-py";
import type { ExecuteCodeReport } from "../exec/code-tool";

describe("hades exec run (real JS sandbox, real tools, real ledger)", () => {
  it("runs an inline JS program that chains real tools and prints a verified trace", async () => {
    const res = await runExecCommand([
      "run",
      'const a = await tools.call("calc", "6*7"); return a.output;',
    ]);
    const text = res.lines.join("\n");
    expect(res.code).toBe(0);
    expect(text).toContain("ok:          true");
    expect(text).toContain("result:      42");
    expect(text).toContain("rpc calls:   1");
    expect(text).toMatch(/trace:\s+sha256:[0-9a-f]{64}/);
    expect(text).toContain("VERIFIED (1 record");
  });

  it("chains multiple tools in one program — every dispatch lands in the chain", async () => {
    const res = await runExecCommand([
      "run",
      'const n = await tools.call("extract_numbers", "a 3 b 4"); ' +
        'const s = await tools.call("calc", n.output.replace(",", "+")); ' +
        "return s.output;",
    ]);
    const text = res.lines.join("\n");
    expect(res.code).toBe(0);
    expect(text).toContain("result:      7");
    expect(text).toContain("rpc calls:   2");
    expect(text).toContain("VERIFIED (2 records");
  });

  it("loads the program from --file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-exec-cli-"));
    try {
      const file = join(dir, "prog.js");
      writeFileSync(file, 'const r = await tools.call("uppercase", "styx"); return r.output;');
      const res = await runExecCommand(["run", "--file", file]);
      expect(res.code).toBe(0);
      expect(res.lines.join("\n")).toContain("result:      STYX");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a failing program honestly with exit code 1 (no fabricated success)", async () => {
    const res = await runExecCommand(["run", "throw new Error('boom');"]);
    const text = res.lines.join("\n");
    expect(res.code).toBe(1);
    expect(text).toContain("ok:          false");
    expect(text).toContain("error:       boom");
  });

  it("hard-kills a runaway program at the configured timeout", async () => {
    const res = await runExecCommand(["run", "while (true) {}"], { timeoutMs: 300 });
    const text = res.lines.join("\n");
    expect(res.code).toBe(1);
    expect(text).toContain("timed out:   true");
  }, 15000);

  it("runs Python via --lang python when python3 exists, or reports python_unavailable honestly", async () => {
    const available = await isPythonAvailable();
    const res = await runExecCommand([
      "run",
      "--lang",
      "python",
      'r = tools_call("calc", "10*4")\nset_result(r["output"])',
    ]);
    const text = res.lines.join("\n");
    if (available) {
      expect(res.code).toBe(0);
      expect(text).toContain("language:    python");
      expect(text).toContain("result:      40");
      expect(text).toContain("VERIFIED (1 record");
    } else {
      expect(res.code).toBe(1);
      expect(text).toContain("python_unavailable");
    }
  }, 20000);

  it("rejects misuse: no code, bad --lang, --file plus inline code, unknown sub", async () => {
    expect((await runExecCommand(["run"])).code).toBe(1);
    expect((await runExecCommand(["run", "--lang", "cobol", "return 1;"])).code).toBe(1);
    expect((await runExecCommand(["run", "--file", "/x", "return 1;"])).code).toBe(1);
    expect((await runExecCommand(["nope"])).code).toBe(1);
    expect((await runExecCommand([])).code).toBe(0); // bare `hades exec` prints usage
  });
});

describe("hades exec bench (Phase 1 checkpoint through the CLI)", () => {
  it("prints counted numbers from the real bench: 1 programmatic turn, agreeing answers, verified trace", async () => {
    const res = await runExecCommand(["bench"]);
    const text = res.lines.join("\n");
    expect(res.code).toBe(0);

    // The programmatic side is literally one execute_code invocation.
    const turnsLine = res.lines.find((l) => l.includes("model turns:"));
    expect(turnsLine).toBeDefined();
    const counts = turnsLine!.match(/(\d+)\s+(\d+)\s*$/);
    expect(counts).not.toBeNull();
    const reactTurns = Number(counts![1]);
    const progTurns = Number(counts![2]);
    expect(progTurns).toBe(1);
    expect(reactTurns).toBeGreaterThanOrEqual(4); // multi-turn ReAct protocol walk

    expect(text).toContain("answers agree:       true");
    // Programmatic trace verified; ReAct transcript has nothing to verify.
    expect(text).toMatch(/verified trace:\s+false\s+true/);
    // Honesty labelling is part of the output, not buried in a comment.
    expect(text).toContain("deterministic scripted stand-in");
  }, 30000);
});

describe("hades CLI router integration", () => {
  it("routes `hades exec run` end to end and lists exec in help", async () => {
    const cli = new HadesCli({});
    const run = await cli.run(["exec", "run", 'return (await tools.call("word_count", "a b c")).output;']);
    expect(run.code).toBe(0);
    expect(run.lines.join("\n")).toContain("result:      3");

    const help = await cli.run(["help"]);
    expect(help.lines.join("\n")).toContain("exec <run|bench>");
  });
});

describe("execEnabledRegistry central wiring", () => {
  it("registers execute_code alongside the builtin tools on the SAME registry", () => {
    const registry = execEnabledRegistry();
    expect(registry.names()).toContain("execute_code");
    expect(registry.names()).toContain("calc");
    expect(registry.get("execute_code")?.description).toContain("tools.call");
  });

  it("execute_code from the wired registry runs real programs against its sibling tools", async () => {
    const registry = execEnabledRegistry();
    const result = await registry.run({
      tool: "execute_code",
      input: 'return (await tools.call("lowercase", "HADES")).output;',
    });
    expect(result.ok).toBe(true);
    const report = JSON.parse(result.output) as ExecuteCodeReport;
    expect(report.result).toBe("hades");
    expect(report.rpcCalls).toBe(1);
  });

  it("self-recursion through the wired registry is structurally denied", async () => {
    const registry = execEnabledRegistry();
    const result = await registry.run({
      tool: "execute_code",
      input: 'return JSON.stringify(await tools.call("execute_code", "return 1;"));',
    });
    // The outer program runs fine; the inner dispatch is refused by the bridge.
    expect(result.ok).toBe(true);
    const report = JSON.parse(result.output) as ExecuteCodeReport;
    const inner = JSON.parse(report.result) as { ok: boolean; output: string };
    expect(inner.ok).toBe(false);
    expect(inner.output).toContain("not allowed");
  });
});
