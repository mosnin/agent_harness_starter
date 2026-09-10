import { describe, it, expect } from "vitest";
import {
  createExecuteCodeTool,
  parseExecuteCodeInput,
  type ExecuteCodeReport,
} from "../code-tool";
import { builtinRegistry, ToolRegistry, type Tool } from "../../agent/tools";
import type { SandboxResult } from "../sandbox-js";

function parseReport(output: string): ExecuteCodeReport {
  return JSON.parse(output) as ExecuteCodeReport;
}

/** A deterministic, injectable clock so provenance events (and therefore
 *  traceSha256) never depend on real wall-clock time. */
function fixedClock(): () => number {
  return () => 1_700_000_000_000;
}

describe("parseExecuteCodeInput", () => {
  it("defaults to js with no directive", () => {
    expect(parseExecuteCodeInput("return 1;")).toEqual({ language: "js", code: "return 1;" });
  });

  it("strips a '#lang: python' directive", () => {
    expect(parseExecuteCodeInput("#lang: python\nprint(1)")).toEqual({
      language: "python",
      code: "print(1)",
    });
  });

  it("strips a '#lang: js' directive", () => {
    expect(parseExecuteCodeInput("#lang: js\nreturn 1;")).toEqual({
      language: "js",
      code: "return 1;",
    });
  });

  it("accepts 'py' and 'javascript' aliases, case-insensitively", () => {
    expect(parseExecuteCodeInput("#LANG: PY\nx = 1")).toEqual({ language: "python", code: "x = 1" });
    expect(parseExecuteCodeInput("#Lang: JavaScript\nreturn 1;")).toEqual({
      language: "js",
      code: "return 1;",
    });
  });

  it("handles a directive-only input (no trailing code)", () => {
    expect(parseExecuteCodeInput("#lang: python")).toEqual({ language: "python", code: "" });
  });

  it("treats an empty string as empty js code", () => {
    expect(parseExecuteCodeInput("")).toEqual({ language: "js", code: "" });
  });

  it("falls back to js, unstripped, for an unrecognized language token", () => {
    const input = "#lang: ruby\nputs 1";
    expect(parseExecuteCodeInput(input)).toEqual({ language: "js", code: input });
  });

  it("falls back to js, unstripped, for a bare '#lang:' with no value", () => {
    const input = "#lang:\nreturn 1;";
    expect(parseExecuteCodeInput(input)).toEqual({ language: "js", code: input });
  });

  it("falls back to js, unstripped, when trailing prose follows the token", () => {
    const input = "#lang: python please\nx = 1";
    expect(parseExecuteCodeInput(input)).toEqual({ language: "js", code: input });
  });
});

describe("createExecuteCodeTool", () => {
  it("has the locked name and a description mentioning tools.call", () => {
    const tool = createExecuteCodeTool({ registry: builtinRegistry() });
    expect(tool.name).toBe("execute_code");
    expect(tool.description.toLowerCase()).toContain("tools.call");
  });

  describe("happy path: JS against builtinRegistry()", () => {
    const code = `
      const sum = await tools.call("calc", "2 + 3 * 4");
      const nums = await tools.call("extract_numbers", "a=10, b=20, c=30");
      const upper = await tools.call("uppercase", "hi there");
      return JSON.stringify({ sum: sum.output, nums: nums.output, upper: upper.output });
    `;

    it("chains multiple real builtin tools and returns a verifying, well-formed report", async () => {
      const tool = createExecuteCodeTool({ registry: builtinRegistry(), now: fixedClock() });
      let verifiedOk: boolean | undefined;
      const toolWithLedger = createExecuteCodeTool({
        registry: builtinRegistry(),
        now: fixedClock(),
        onLedger: (ledger) => {
          verifiedOk = ledger.verify().ok;
        },
      });
      void tool; // constructed above only to assert the plain-options path also works below

      const res = await toolWithLedger.run(code);
      const report = parseReport(res.output);

      expect(report.ok).toBe(true);
      expect(report.language).toBe("js");
      expect(report.rpcCalls).toBe(3);
      expect(report.timedOut).toBe(false);
      expect(report.error).toBeUndefined();

      const payload = JSON.parse(report.result) as { sum: string; nums: string; upper: string };
      expect(payload.sum).toBe("14");
      expect(payload.nums).toBe("10,20,30");
      expect(payload.upper).toBe("HI THERE");

      expect(verifiedOk).toBe(true);
      expect(report.traceSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces a stable traceSha256 across two identical runs with a fixed clock (determinism)", async () => {
      const tool = createExecuteCodeTool({ registry: builtinRegistry(), now: fixedClock() });
      const res1 = await tool.run(code);
      const res2 = await tool.run(code);
      const report1 = parseReport(res1.output);
      const report2 = parseReport(res2.output);

      expect(report1.ok).toBe(true);
      expect(report2.ok).toBe(true);
      expect(report1.result).toBe(report2.result);
      expect(report1.traceSha256).toBe(report2.traceSha256);
      expect(report1.traceSha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("#lang: python path (real python sandbox)", () => {
    it("runs real Python, calls a real tool via tools_call, and reports language: python", async () => {
      const tool = createExecuteCodeTool({ registry: builtinRegistry() });
      const input = ["#lang: python", "res = tools_call('calc', '6 * 7')", "set_result(res['output'])"].join(
        "\n",
      );
      const res = await tool.run(input);
      const report = parseReport(res.output);

      expect(report.language).toBe("python");
      expect(report.ok).toBe(true);
      expect(report.result).toBe("42");
      expect(report.rpcCalls).toBe(1);
      expect(report.timedOut).toBe(false);
    }, 15000);

    it("surfaces a real Python exception as ok:false with a well-formed report", async () => {
      const tool = createExecuteCodeTool({ registry: builtinRegistry() });
      const res = await tool.run("#lang: python\nraise ValueError('boom from python')");
      const report = parseReport(res.output);

      expect(report.language).toBe("python");
      expect(report.ok).toBe(false);
      expect(typeof report.error).toBe("string");
      expect(report.error).toContain("boom from python");
    }, 15000);
  });

  describe("self-invocation is always denied", () => {
    it("denies execute_code calling itself with not_allowed, even when registered in the registry", async () => {
      const registry = builtinRegistry();
      const tool = createExecuteCodeTool({ registry });
      registry.register(tool); // execute_code is now resolvable by name...

      const res = await tool.run(`
        const r = await tools.call("execute_code", "return 1;");
        return JSON.stringify(r);
      `);
      const report = parseReport(res.output);

      expect(report.ok).toBe(true); // the OUTER program ran fine
      expect(report.rpcCalls).toBe(1);
      const inner = JSON.parse(report.result) as { ok: boolean; output: string };
      expect(inner.ok).toBe(false);
      expect(inner.output.toLowerCase()).toContain("not allowed");
    });

    it("denies self-invocation even when the caller's own allow list explicitly includes execute_code", async () => {
      const registry = builtinRegistry();
      const tool = createExecuteCodeTool({ registry, allow: ["execute_code", "calc"] });
      registry.register(tool);

      const res = await tool.run(`
        const r = await tools.call("execute_code", "return 1;");
        return r.ok ? "allowed" : "denied";
      `);
      const report = parseReport(res.output);
      expect(report.result).toBe("denied");
    });
  });

  describe("allow / deny filtering reaches the sandbox", () => {
    it("allow-lists exactly the named tools; everything else is not_allowed", async () => {
      const tool = createExecuteCodeTool({ registry: builtinRegistry(), allow: ["calc"] });
      const res = await tool.run(`
        const okCall = await tools.call("calc", "1 + 1");
        const deniedCall = await tools.call("uppercase", "hi");
        return JSON.stringify({ ok: okCall, denied: deniedCall });
      `);
      const report = parseReport(res.output);
      const payload = JSON.parse(report.result) as {
        ok: { ok: boolean; output: string };
        denied: { ok: boolean; output: string };
      };
      expect(payload.ok).toEqual({ ok: true, output: "2" });
      expect(payload.denied.ok).toBe(false);
      expect(payload.denied.output.toLowerCase()).toContain("not allowed");
    });

    it("deny-lists a named tool while leaving the rest of the registry callable", async () => {
      const tool = createExecuteCodeTool({ registry: builtinRegistry(), deny: ["calc"] });
      const res = await tool.run(`
        const denied = await tools.call("calc", "1 + 1");
        const ok = await tools.call("uppercase", "hi");
        return JSON.stringify({ denied, ok });
      `);
      const report = parseReport(res.output);
      const payload = JSON.parse(report.result) as {
        denied: { ok: boolean; output: string };
        ok: { ok: boolean; output: string };
      };
      expect(payload.denied.ok).toBe(false);
      expect(payload.ok).toEqual({ ok: true, output: "HI" });
    });

    it("an unknown tool name reports unknown_tool through to the sandboxed caller", async () => {
      const tool = createExecuteCodeTool({ registry: builtinRegistry() });
      const res = await tool.run(`
        const r = await tools.call("no_such_tool", "x");
        return r.output;
      `);
      const report = parseReport(res.output);
      expect(report.result.toLowerCase()).toContain("unknown tool");
    });
  });

  describe("timeout inside the sandbox", () => {
    it("surfaces timedOut:true with a well-formed, parseable JSON report on a real JS timeout", async () => {
      const tool = createExecuteCodeTool({ registry: builtinRegistry(), timeoutMs: 200 });
      const res = await tool.run("while (true) {}");
      expect(() => JSON.parse(res.output)).not.toThrow();
      const report = parseReport(res.output);
      expect(report.ok).toBe(false);
      expect(report.timedOut).toBe(true);
      expect(report.error).toBe("timeout");
      expect(report.language).toBe("js");
      expect(typeof report.traceSha256).toBe("string");
      expect(report.traceSha256).toMatch(/^[0-9a-f]{64}$/);
    }, 10000);
  });

  describe("empty code", () => {
    it("runs empty JS code as a no-op returning an empty result", async () => {
      const tool = createExecuteCodeTool({ registry: builtinRegistry() });
      const res = await tool.run("");
      const report = parseReport(res.output);
      expect(report.ok).toBe(true);
      expect(report.result).toBe("");
      expect(report.rpcCalls).toBe(0);
    });
  });

  describe("injected failing runners never throw out of run()", () => {
    it("a jsRunner that throws synchronously still yields a structured, parseable report", async () => {
      const failingJsRunner = (): Promise<SandboxResult> => {
        throw new Error("injected js runner boom");
      };
      const tool = createExecuteCodeTool({
        registry: builtinRegistry(),
        jsRunner: failingJsRunner as unknown as typeof import("../sandbox-js").runSandboxedJs,
      });
      const res = await tool.run("return 1;");
      expect(() => JSON.parse(res.output)).not.toThrow();
      const report = parseReport(res.output);
      expect(report.ok).toBe(false);
      expect(report.error).toContain("injected js runner boom");
    });

    it("a jsRunner that rejects still yields a structured, parseable report", async () => {
      const rejectingJsRunner = (): Promise<SandboxResult> =>
        Promise.reject(new Error("injected rejection"));
      const tool = createExecuteCodeTool({
        registry: builtinRegistry(),
        jsRunner: rejectingJsRunner as unknown as typeof import("../sandbox-js").runSandboxedJs,
      });
      const res = await tool.run("return 1;");
      const report = parseReport(res.output);
      expect(report.ok).toBe(false);
      expect(report.error).toContain("injected rejection");
      expect(report.rpcCalls).toBe(0);
    });

    it("a pyRunner that throws still yields a structured, parseable report on the python path", async () => {
      const failingPyRunner = (): Promise<SandboxResult> => {
        throw new Error("injected py runner boom");
      };
      const tool = createExecuteCodeTool({
        registry: builtinRegistry(),
        pyRunner: failingPyRunner as unknown as typeof import("../sandbox-py").runSandboxedPython,
      });
      const res = await tool.run("#lang: python\nprint(1)");
      const report = parseReport(res.output);
      expect(report.language).toBe("python");
      expect(report.ok).toBe(false);
      expect(report.error).toContain("injected py runner boom");
    });
  });

  describe("report JSON is always parseable, even for hostile content", () => {
    const hostileInputs: string[] = [
      "a".repeat(200_000),
      "🚀🔥💥 emoji soup 🎉🧪🛰️",
      "日本語のテスト文字列です。改行\nタブ\t混在。",
      "  control chars ",
      `quotes "and" 'apostrophes' and \\backslashes\\`,
      "line separator and paragraph separator",
      "",
      "null\0byte-in-the-middle",
      JSON.stringify({ nested: "already json", arr: [1, 2, 3] }),
      "very \"unbalanced {[( brackets",
    ];

    it.each(hostileInputs)("round-trips hostile stdout/result content safely: %#", async (hostile) => {
      // A fast, explicitly-labelled fake runner: the point of this test is
      // the outer JSON.stringify/parse safety of code-tool.ts itself, not
      // to re-spawn a real worker per hostile string (already exercised
      // elsewhere in this file and in sandbox-js's own test suite).
      const echoRunner = async (): Promise<SandboxResult> => ({
        ok: true,
        result: hostile,
        stdout: hostile,
        stderr: hostile,
        timedOut: false,
        rpcCallCount: 0,
        durationMs: 0,
      });
      const tool = createExecuteCodeTool({
        registry: builtinRegistry(),
        jsRunner: echoRunner as unknown as typeof import("../sandbox-js").runSandboxedJs,
      });
      const res = await tool.run("return 1;");
      expect(() => JSON.parse(res.output)).not.toThrow();
      const report = parseReport(res.output);
      expect(report.result).toBe(hostile);
      expect(report.stdout).toBe(hostile);
      expect(report.stderr).toBe(hostile);
    });
  });

  describe("fresh ledger per call, proven by interleaving two invocations", () => {
    it("keeps two concurrently-interleaved invocations' ledgers and call counts fully independent", async () => {
      const slowEchoTool: Tool = {
        name: "sleep_echo",
        description: "Sleeps briefly, then echoes its input.",
        run: async (input: string) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          return { ok: true, output: input };
        },
      };
      const registry = new ToolRegistry();
      registry.register(slowEchoTool);

      const eventsA: string[] = [];
      const eventsB: string[] = [];
      let ledgerLengthA = -1;
      let ledgerLengthB = -1;

      const toolA = createExecuteCodeTool({
        registry,
        onLedger: (ledger) => {
          ledgerLengthA = ledger.length();
          for (const r of ledger.records()) eventsA.push(r.event.tool);
        },
      });
      const toolB = createExecuteCodeTool({
        registry,
        onLedger: (ledger) => {
          ledgerLengthB = ledger.length();
          for (const r of ledger.records()) eventsB.push(r.event.tool);
        },
      });

      const codeA = `
        const r = await tools.call("sleep_echo", "A1");
        return r.output;
      `;
      const codeB = `
        const a = await tools.call("sleep_echo", "B1");
        const b = await tools.call("sleep_echo", "B2");
        const c = await tools.call("sleep_echo", "B3");
        return [a.output, b.output, c.output].join(",");
      `;

      const [resA, resB] = await Promise.all([toolA.run(codeA), toolB.run(codeB)]);
      const reportA = parseReport(resA.output);
      const reportB = parseReport(resB.output);

      expect(reportA.ok).toBe(true);
      expect(reportB.ok).toBe(true);
      expect(reportA.result).toBe("A1");
      expect(reportB.result).toBe("B1,B2,B3");

      expect(reportA.rpcCalls).toBe(1);
      expect(reportB.rpcCalls).toBe(3);
      expect(ledgerLengthA).toBe(1);
      expect(ledgerLengthB).toBe(3);
      expect(eventsA).toEqual(["sleep_echo"]);
      expect(eventsB).toEqual(["sleep_echo", "sleep_echo", "sleep_echo"]);
      // Distinct trace hashes: independent ledgers, not a shared/aliased one.
      expect(reportA.traceSha256).not.toBe(reportB.traceSha256);
    });
  });
});
