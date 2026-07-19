/**
 * Tests for the `shell` tool: a real quote-aware tokenizer, a
 * deny-by-default allowlist gate, fake-SpawnLike coverage of every
 * policy branch, and a REAL spawn integration test proving the actual
 * timeout/SIGKILL and output-cap behavior of `realSpawn()`.
 */
import { describe, it, expect } from "vitest";
import {
  tokenizeCommandLine,
  createShellTool,
  realSpawn,
  type SpawnLike,
  type SpawnResult,
  type CatalogEntry,
} from "../shell";

/* ------------------------------------------------------------------ *
 * Tokenizer
 * ------------------------------------------------------------------ */

describe("tokenizeCommandLine", () => {
  it("splits on whitespace", () => {
    expect(tokenizeCommandLine("echo hello world")).toEqual(["echo", "hello", "world"]);
  });

  it("collapses repeated whitespace and trims", () => {
    expect(tokenizeCommandLine("  echo   hello  ")).toEqual(["echo", "hello"]);
  });

  it("returns an empty array for an empty or all-whitespace line", () => {
    expect(tokenizeCommandLine("")).toEqual([]);
    expect(tokenizeCommandLine("   \t  ")).toEqual([]);
  });

  it("handles single-quoted tokens literally, no escapes inside", () => {
    expect(tokenizeCommandLine(`echo 'hello world'`)).toEqual(["echo", "hello world"]);
    expect(tokenizeCommandLine(`echo 'a\\nb'`)).toEqual(["echo", "a\\nb"]);
  });

  it("handles double-quoted tokens with backslash escapes for \" \\ $ `", () => {
    expect(tokenizeCommandLine(`echo "hello world"`)).toEqual(["echo", "hello world"]);
    expect(tokenizeCommandLine(`echo "say \\"hi\\""`)).toEqual(["echo", 'say "hi"']);
    expect(tokenizeCommandLine(`echo "a\\\\b"`)).toEqual(["echo", "a\\b"]);
    expect(tokenizeCommandLine(`echo "\\$HOME"`)).toEqual(["echo", "$HOME"]);
  });

  it("supports adjacent quoted/unquoted segments forming one token", () => {
    expect(tokenizeCommandLine(`echo foo'bar baz'qux`)).toEqual(["echo", "foobar bazqux"]);
  });

  it("escapes a literal space outside quotes into one token", () => {
    expect(tokenizeCommandLine(`echo hello\\ world`)).toEqual(["echo", "hello world"]);
  });

  it("throws on an unterminated single quote", () => {
    expect(() => tokenizeCommandLine(`echo 'unterminated`)).toThrow(/unterminated single quote/);
  });

  it("throws on an unterminated double quote", () => {
    expect(() => tokenizeCommandLine(`echo "unterminated`)).toThrow(/unterminated double quote/);
  });

  it("throws on a trailing unescaped backslash", () => {
    expect(() => tokenizeCommandLine(`echo foo\\`)).toThrow(/trailing unescaped backslash/);
  });

  it("does not interpret shell metacharacters — they stay literal token content", () => {
    expect(tokenizeCommandLine("echo;rm -rf /")).toEqual(["echo;rm", "-rf", "/"]);
    expect(tokenizeCommandLine("echo $(whoami)")).toEqual(["echo", "$(whoami)"]);
    expect(tokenizeCommandLine("echo a | b")).toEqual(["echo", "a", "|", "b"]);
    expect(tokenizeCommandLine("echo a && b")).toEqual(["echo", "a", "&&", "b"]);
    expect(tokenizeCommandLine("echo `id`")).toEqual(["echo", "`id`"]);
  });
});

/* ------------------------------------------------------------------ *
 * Fake SpawnLike harness
 * ------------------------------------------------------------------ */

function fakeSpawn(
  handler: (cmd: string, args: string[]) => SpawnResult
): { spawn: SpawnLike; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn: SpawnLike = async (cmd, args) => {
    calls.push({ cmd, args });
    return handler(cmd, args);
  };
  return { spawn, calls };
}

function okResult(stdout: string): SpawnResult {
  return { code: 0, stdout, stderr: "", timedOut: false, truncated: false };
}

async function runTool(entry: CatalogEntry, input: string) {
  const result = await entry.tool.run(input);
  return { ok: result.ok, body: JSON.parse(result.output) };
}

describe("createShellTool: catalog metadata", () => {
  it("matches the locked contract", () => {
    const { spawn } = fakeSpawn(() => okResult(""));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    expect(entry.id).toBe("shell");
    expect(entry.tool.name).toBe("shell");
    expect(entry.category).toBe("system");
    expect(entry.mode).toBe("real");
    expect(entry.requiresNetwork).toBe(false);
    expect(entry.requiredEnvKeys).toEqual([]);
    expect(entry.verifierId).toBe("verify.shell");
  });
});

describe("createShellTool: allowlist gate", () => {
  it("runs an allowed bare command line", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult("hi\n"));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, "echo hi");
    expect(r.ok).toBe(true);
    expect(r.body.code).toBe(0);
    expect(r.body.stdout).toBe("hi\n");
    expect(calls).toEqual([{ cmd: "echo", args: ["hi"] }]);
  });

  it("runs the structured JSON form", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult("json-ok"));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, JSON.stringify({ cmd: "echo", args: ["a", "b"] }));
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ cmd: "echo", args: ["a", "b"] }]);
  });

  it("rejects a command not on the allowlist", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult(""));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, "cat /etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/not allowed/);
    expect(calls).toEqual([]);
  });

  it("rejects a path-qualified bypass attempt (/bin/sh) when only 'echo' is allowed", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult(""));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, "/bin/sh -c whoami");
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/not allowed/);
    expect(calls).toEqual([]);
  });

  it("rejects an uppercase bypass attempt (ECHO) — allowlist is case-sensitive on basename", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult(""));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, "ECHO hi");
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("treats 'echo;rm -rf /' as one literal, uninterpreted argv[0] — never runs rm", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult(""));
    const entry = createShellTool({ policy: { allowedCommands: ["echo", "rm"] }, spawn });
    const r = await runTool(entry, "echo;rm -rf /");
    // "echo;rm" is the literal argv[0] — not equal to the allowed basename
    // "echo", and no shell ever splits it on the semicolon.
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/not allowed/);
    expect(calls).toEqual([]);
  });

  it("allows a basename match even when invoked via a path under an allowed dir policy is not assumed", async () => {
    // basename() of a qualified allowed command still matches by design
    // (the allowlist is basenames), e.g. "/usr/bin/echo" is allowed when
    // "echo" is on the list.
    const { spawn, calls } = fakeSpawn(() => okResult("ok"));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, "/usr/bin/echo hi");
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ cmd: "/usr/bin/echo", args: ["hi"] }]);
  });
});

describe("createShellTool: denyArgPatterns", () => {
  it("rejects an argument matching a deny pattern", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult(""));
    const entry = createShellTool({
      policy: { allowedCommands: ["echo"], denyArgPatterns: [/secret/i] },
      spawn,
    });
    const r = await runTool(entry, "echo my-SECRET-value");
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/denied pattern/);
    expect(calls).toEqual([]);
  });

  it("checks argv[0] against deny patterns too, not just args", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult(""));
    const entry = createShellTool({
      policy: { allowedCommands: ["echo"], denyArgPatterns: [/^echo$/] },
      spawn,
    });
    const r = await runTool(entry, "echo hi");
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("allows args that do not match any deny pattern", async () => {
    const { spawn } = fakeSpawn(() => okResult("clean"));
    const entry = createShellTool({
      policy: { allowedCommands: ["echo"], denyArgPatterns: [/secret/i] },
      spawn,
    });
    const r = await runTool(entry, "echo totally-fine");
    expect(r.ok).toBe(true);
  });
});

describe("createShellTool: newline/NUL argument rejection", () => {
  it("rejects an argument containing a newline (JSON form)", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult(""));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, JSON.stringify({ cmd: "echo", args: ["a\nb"] }));
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/newline/);
    expect(calls).toEqual([]);
  });

  it("rejects an argument containing a NUL byte (JSON form)", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult(""));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, JSON.stringify({ cmd: "echo", args: ["a\0b"] }));
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("createShellTool: result shape and exit codes", () => {
  it("reports ok:false when the command exits non-zero", async () => {
    const { spawn } = fakeSpawn(() => ({ code: 1, stdout: "", stderr: "boom", timedOut: false, truncated: false }));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, "echo fail");
    expect(r.ok).toBe(false);
    expect(r.body.code).toBe(1);
    expect(r.body.stderr).toBe("boom");
  });

  it("reports ok:false when the command timed out, even if code looks like 0", async () => {
    const { spawn } = fakeSpawn(() => ({ code: 0, stdout: "", stderr: "", timedOut: true, truncated: false }));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, "echo slow");
    expect(r.ok).toBe(false);
    expect(r.body.timedOut).toBe(true);
  });

  it("passes through truncated:true from the spawn result", async () => {
    const { spawn } = fakeSpawn(() => ({ code: 0, stdout: "abc", stderr: "", timedOut: false, truncated: true }));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, "echo big");
    expect(r.body.truncated).toBe(true);
  });

  it("surfaces a spawn rejection as ok:false rather than throwing", async () => {
    const spawn: SpawnLike = async () => {
      throw new Error("spawn ENOENT");
    };
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const r = await runTool(entry, "echo hi");
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/ENOENT/);
  });

  it("uses default timeoutMs/maxOutputBytes when the policy omits them", async () => {
    let seenOpts: any;
    const spawn: SpawnLike = async (_cmd, _args, opts) => {
      seenOpts = opts;
      return okResult("");
    };
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    await runTool(entry, "echo hi");
    expect(seenOpts.timeoutMs).toBe(10000);
    expect(seenOpts.maxOutputBytes).toBe(131072);
  });

  it("honors custom timeoutMs/maxOutputBytes from the policy", async () => {
    let seenOpts: any;
    const spawn: SpawnLike = async (_cmd, _args, opts) => {
      seenOpts = opts;
      return okResult("");
    };
    const entry = createShellTool({
      policy: { allowedCommands: ["echo"], timeoutMs: 5000, maxOutputBytes: 4096 },
      spawn,
    });
    await runTool(entry, "echo hi");
    expect(seenOpts.timeoutMs).toBe(5000);
    expect(seenOpts.maxOutputBytes).toBe(4096);
  });

  it("passes cwd through to the spawn seam", async () => {
    let seenOpts: any;
    const spawn: SpawnLike = async (_cmd, _args, opts) => {
      seenOpts = opts;
      return okResult("");
    };
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn, cwd: "/tmp" });
    await runTool(entry, "echo hi");
    expect(seenOpts.cwd).toBe("/tmp");
  });
});

describe("createShellTool: malformed input never throws", () => {
  const malformed = [
    "",
    "   ",
    "'unterminated",
    '"unterminated',
    "echo foo\\",
    "{}",
    '{"cmd":123}',
    '{"cmd":"echo","args":"not-an-array"}',
    '{"cmd":"echo","args":[1,2,3]}',
    "{not valid json but starts with brace",
  ];

  it.each(malformed)("returns ok:false for malformed input %#", async (input) => {
    const { spawn, calls } = fakeSpawn(() => okResult(""));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    const result = await entry.tool.run(input);
    expect(result.ok).toBe(false);
    expect(() => JSON.parse(result.output)).not.toThrow();
    // None of these should ever have reached the spawn seam except the
    // valid-but-nonstandard-args-array case, which is rejected before
    // spawning in every case here.
    expect(calls).toEqual([]);
  });

  it("survives a seeded fuzz loop of 200 malformed inputs without throwing", async () => {
    const { spawn } = fakeSpawn(() => okResult(""));
    const entry = createShellTool({ policy: { allowedCommands: ["echo"] }, spawn });
    let seed = 98765;
    function rand(): number {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    const chars = '{}[]":,0123456789abcXYZ\'"\\;|&$`.._- \n\t\0';
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(rand() * 40);
      let s = "";
      for (let j = 0; j < len; j++) {
        s += chars[Math.floor(rand() * chars.length)];
      }
      const result = await entry.tool.run(s);
      expect(typeof result.output).toBe("string");
      expect(() => JSON.parse(result.output)).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Real spawn integration test — proves realSpawn() actually enforces
 * the timeout (SIGKILL) and output caps against a live child process.
 * ------------------------------------------------------------------ */

describe("realSpawn: real process integration", () => {
  it("runs a real node -e process and captures stdout/exit code", async () => {
    const spawnFn = realSpawn();
    const result = await spawnFn("node", ["-e", "console.log('real-output')"], {
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("real-output");
    expect(result.timedOut).toBe(false);
  }, 10000);

  it("kills a real process that outlives the timeout (SIGKILL) and marks timedOut", async () => {
    const spawnFn = realSpawn();
    const start = Date.now();
    const result = await spawnFn("node", ["-e", "setTimeout(() => {}, 60000)"], {
      timeoutMs: 300,
      maxOutputBytes: 65536,
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    // A SIGKILL'd process cannot exit 0; node reports a non-zero/killed
    // code (often null on some platforms) — assert it's not a clean 0.
    expect(result.code).not.toBe(0);
    // Should not have waited anywhere near the process's own 60s timer.
    expect(elapsed).toBeLessThan(5000);
  }, 10000);

  it("truncates output at maxOutputBytes for a real process and marks truncated", async () => {
    const spawnFn = realSpawn();
    const result = await spawnFn(
      "node",
      ["-e", "process.stdout.write('A'.repeat(5000))"],
      { timeoutMs: 5000, maxOutputBytes: 100 }
    );
    expect(result.stdout.length).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
  }, 10000);

  it("runs through the full createShellTool with a real spawn end to end", async () => {
    const entry = createShellTool({
      policy: { allowedCommands: ["node"], timeoutMs: 5000 },
    });
    const r = await runTool(entry, JSON.stringify({ cmd: "node", args: ["-e", "console.log(2 + 2)"] }));
    expect(r.ok).toBe(true);
    expect(r.body.stdout).toContain("4");
  }, 10000);
});
