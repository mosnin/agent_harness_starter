import { describe, it, expect } from "vitest";
import {
  ToolRegistry,
  builtinTools,
  builtinRegistry,
  type Tool,
} from "../agent/tools";

describe("calc", () => {
  const calc = builtinRegistry();
  const run = (input: string) => calc.run({ tool: "calc", input });

  it("respects order of operations", async () => {
    expect(await run("2+3*4")).toEqual({ ok: true, output: "14" });
  });

  it("handles parentheses, decimals, unary minus and modulo", async () => {
    expect(await run("(2+3)*4")).toEqual({ ok: true, output: "20" });
    expect(await run("10/4")).toEqual({ ok: true, output: "2.5" });
    expect(await run("-5+2")).toEqual({ ok: true, output: "-3" });
    expect(await run("10%3")).toEqual({ ok: true, output: "1" });
    expect(await run("1.5+2.5")).toEqual({ ok: true, output: "4" });
  });

  it("returns ok:false on divide-by-zero", async () => {
    const r = await run("1/0");
    expect(r.ok).toBe(false);
    const m = await run("5%0");
    expect(m.ok).toBe(false);
  });

  it("rejects letters and eval-style payloads without executing them", async () => {
    for (const payload of ["process.exit(1)", "eval('x')", "2+a", "require('fs')", "1;2"]) {
      const r = await run(payload);
      expect(r.ok).toBe(false);
    }
  });
});

describe("extract tools", () => {
  const reg = builtinRegistry();

  it("extracts sorted unique emails", async () => {
    const r = await reg.run({
      tool: "extract_emails",
      input: "reach b@x.com, a@x.com and again b@x.com",
    });
    expect(r).toEqual({ ok: true, output: "a@x.com,b@x.com" });
  });

  it("extracts numbers in order", async () => {
    const r = await reg.run({
      tool: "extract_numbers",
      input: "a 3 then 10 and -2.5 end",
    });
    expect(r).toEqual({ ok: true, output: "3,10,-2.5" });
  });
});

describe("json_get", () => {
  const reg = builtinRegistry();

  it("returns value at happy path", async () => {
    const r = await reg.run({
      tool: "json_get",
      input: '{"a":{"b":[10,20]}} | a.b.1',
    });
    expect(r).toEqual({ ok: true, output: "20" });
  });

  it("returns ok:false on bad path", async () => {
    const r = await reg.run({
      tool: "json_get",
      input: '{"a":1} | a.b.c',
    });
    expect(r.ok).toBe(false);
  });

  it("returns ok:false on invalid json", async () => {
    const r = await reg.run({ tool: "json_get", input: "{bad | a" });
    expect(r.ok).toBe(false);
  });
});

describe("to_json", () => {
  const reg = builtinRegistry();

  it("coerces numbers and preserves key order", async () => {
    const r = await reg.run({ tool: "to_json", input: "name=bob, age=42, city=nyc" });
    expect(r).toEqual({ ok: true, output: '{"name":"bob","age":42,"city":"nyc"}' });
  });
});

describe("word_count / case", () => {
  const reg = builtinRegistry();

  it("counts whitespace tokens", async () => {
    expect(await reg.run({ tool: "word_count", input: "  one  two three " })).toEqual({
      ok: true,
      output: "3",
    });
    expect(await reg.run({ tool: "word_count", input: "   " })).toEqual({
      ok: true,
      output: "0",
    });
  });

  it("does real case transforms", async () => {
    expect(await reg.run({ tool: "uppercase", input: "aB" })).toEqual({ ok: true, output: "AB" });
    expect(await reg.run({ tool: "lowercase", input: "aB" })).toEqual({ ok: true, output: "ab" });
  });
});

describe("ToolRegistry guards", () => {
  it("guards unknown tools", async () => {
    const reg = builtinRegistry();
    expect(await reg.run({ tool: "nope", input: "x" })).toEqual({
      ok: false,
      output: "unknown tool: nope",
    });
  });

  it("guards a throwing tool without propagating", async () => {
    const reg = new ToolRegistry();
    const boom: Tool = {
      name: "boom",
      description: "throws",
      run: () => {
        throw new Error("kaboom");
      },
    };
    reg.register(boom);
    const r = await reg.run({ tool: "boom", input: "" });
    expect(r).toEqual({ ok: false, output: "error: kaboom" });
  });

  it("lists tools sorted by name", () => {
    const reg = builtinRegistry();
    const names = reg.list().map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(reg.names()).toEqual(names);
    expect(builtinTools()).toHaveLength(8);
  });
});
