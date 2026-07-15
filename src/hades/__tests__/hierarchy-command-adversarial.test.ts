/**
 * ADVERSARIAL VERIFICATION of `hades hierarchy <sub>` (runHierarchyCommand).
 *
 * The goal is to PROVE the command is HONEST and ROBUST, not to conform tests to
 * whatever the implementation happens to print:
 *   - every subcommand resolves to a well-formed { code:number, lines:string[] }
 *     with NO embedded newlines in any single entry (multi-line output must be
 *     pre-split), and never throws / rejects;
 *   - help / unknown / [] route to truthful exit codes and mention the real subs;
 *   - head-to-head runs the REAL harness: a genuine markdown table row plus a
 *     speedup summary whose routing number is > 1 (routing genuinely wins);
 *   - chaos's exit code is tied to the invariant it reports (silent-wrong 0,
 *     allInvariantsHeld true, code 0), not a hardcoded success banner;
 *   - fuzz's exit code reflects pass/fail (checked N, firstFailure null → 0), and
 *     degenerate counts / non-numeric args never crash;
 *   - stats arithmetic matches an INDEPENDENT recomputation of b^(levels+1).
 *
 * Deterministic. Small injected opts keep the whole file to a few seconds.
 */
import { describe, it, expect } from "vitest";
import {
  runHierarchyCommand,
  type HierarchyCommandResult,
} from "../cli/hierarchy-command";

/** Tiny, fast, deterministic sizes for the heavy harnesses. */
const FAST = {
  headToHead: { workerCounts: [16], branching: 4, aggCostPerItem: 50 },
  makespan: { workerCounts: [16, 64] },
  chaos: { runsPerScenario: 1 },
} as const;

/** Assert the universal contract: numeric code + array of newline-free strings. */
function assertValidShape(res: HierarchyCommandResult): void {
  expect(res).toBeTypeOf("object");
  expect(res).not.toBeNull();
  expect(typeof res.code).toBe("number");
  expect(Number.isFinite(res.code)).toBe(true);
  expect(Array.isArray(res.lines)).toBe(true);
  for (const line of res.lines) {
    expect(typeof line).toBe("string");
    // No entry may smuggle multiple lines in one string.
    expect(line).not.toContain("\n");
  }
}

/** Extract every numeric literal from a string. */
function numbersIn(s: string): number[] {
  return (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

// -------------------------------------------------------------------------- //
// 1. RESULT SHAPE ALWAYS VALID
// -------------------------------------------------------------------------- //
describe("result shape is always valid (no throw, split lines)", () => {
  const cases: Array<[string, string[]]> = [
    ["help", ["help"]],
    ["no-arg", []],
    ["empty-array", []],
    ["head-to-head", ["head-to-head"]],
    ["makespan", ["makespan"]],
    ["chaos", ["chaos"]],
    ["fuzz", ["fuzz", "12"]],
    ["stats", ["stats", "2", "2"]],
    ["unknown", ["wat"]],
  ];

  for (const [label, args] of cases) {
    it(`resolves a valid split-lines result for: ${label}`, async () => {
      const res = await runHierarchyCommand(args, FAST);
      assertValidShape(res);
      expect(res.lines.length).toBeGreaterThan(0);
    });
  }

  it("[] and a bare help never reject (within the locked string[] contract)", async () => {
    await expect(runHierarchyCommand([], FAST)).resolves.toBeDefined();
    await expect(runHierarchyCommand(["help"], FAST)).resolves.toBeDefined();
  });
});

// -------------------------------------------------------------------------- //
// 2. HELP / UNKNOWN / []
// -------------------------------------------------------------------------- //
describe("help, unknown, and [] routing", () => {
  it("no-arg → code 0 and lists the real subcommands", async () => {
    const res = await runHierarchyCommand([], FAST);
    assertValidShape(res);
    expect(res.code).toBe(0);
    const blob = res.lines.join("\n");
    expect(blob).toContain("head-to-head");
    expect(blob).toContain("chaos");
    expect(blob).toContain("fuzz");
  });

  it('"help" → code 0 and lists the real subcommands', async () => {
    const res = await runHierarchyCommand(["help"], FAST);
    assertValidShape(res);
    expect(res.code).toBe(0);
    const blob = res.lines.join("\n");
    expect(blob).toContain("head-to-head");
    expect(blob).toContain("chaos");
    expect(blob).toContain("fuzz");
  });

  it('[] behaves like help (code 0)', async () => {
    const res = await runHierarchyCommand([], FAST);
    expect(res.code).toBe(0);
  });

  it('unknown "wat" → code 1 and a line mentions help', async () => {
    const res = await runHierarchyCommand(["wat"], FAST);
    assertValidShape(res);
    expect(res.code).toBe(1);
    expect(res.lines.some((l) => l.toLowerCase().includes("help"))).toBe(true);
  });
});

// -------------------------------------------------------------------------- //
// 3. head-to-head IS REAL
// -------------------------------------------------------------------------- //
describe("head-to-head runs the real harness", () => {
  it("code 0, real markdown table row, and routing speedup > 1", async () => {
    const res = await runHierarchyCommand(["head-to-head"], FAST);
    assertValidShape(res);
    expect(res.code).toBe(0);

    // A genuine markdown table row: many pipes AND digits (measured numbers),
    // not an empty banner.
    const tableRow = res.lines.find(
      (l) => (l.match(/\|/g) ?? []).length >= 3 && /\d/.test(l)
    );
    expect(tableRow, "expected a markdown table row with pipes and digits").toBeDefined();

    // A speedup summary line (case-insensitive) that carries an actual number.
    const speedupLines = res.lines.filter((l) => /speedup/i.test(l));
    expect(speedupLines.length).toBeGreaterThan(0);

    // Parse the routing speedup and assert routing genuinely wins (> 1).
    const routingLine = speedupLines.find(
      (l) => /routing speedup/i.test(l) && numbersIn(l).length > 0
    );
    expect(
      routingLine,
      "expected a routing-speedup summary line carrying a number"
    ).toBeDefined();
    const routingSpeedup = Math.max(...numbersIn(routingLine!));
    expect(routingSpeedup).toBeGreaterThan(1);
  });
});

// -------------------------------------------------------------------------- //
// 4. chaos CODE REFLECTS THE INVARIANT
// -------------------------------------------------------------------------- //
describe("chaos exit code is tied to the reported invariant", () => {
  it("success path: silent-wrong 0, allInvariantsHeld true, code 0", async () => {
    const res = await runHierarchyCommand(["chaos"], FAST);
    assertValidShape(res);
    expect(res.code).toBe(0);

    // The silent-wrong count must actually be reported as 0 (not hidden/hardcoded).
    const silentLine = res.lines.find((l) => /silent[-\s]?wrong/i.test(l));
    expect(silentLine, "expected a silent-wrong line").toBeDefined();
    const silentCount = numbersIn(silentLine!.replace(/silent[-\s]?wrong/i, ""));
    // Last number on the line is the count.
    expect(silentCount[silentCount.length - 1]).toBe(0);

    // allInvariantsHeld must be reported true.
    const invLine = res.lines.find((l) => /allInvariantsHeld/i.test(l));
    expect(invLine, "expected an allInvariantsHeld line").toBeDefined();
    expect(invLine!.toLowerCase()).toContain("true");
  });
});

// -------------------------------------------------------------------------- //
// 5. fuzz CODE REFLECTS PASS/FAIL
// -------------------------------------------------------------------------- //
describe("fuzz exit code reflects pass/fail", () => {
  it('"fuzz 15" → code 0 and reports checked=15 (firstFailure null)', async () => {
    const res = await runHierarchyCommand(["fuzz", "15"], FAST);
    assertValidShape(res);
    expect(res.code).toBe(0);
    const checkedLine = res.lines.find(
      (l) => /checked/i.test(l) && numbersIn(l).includes(15)
    );
    expect(
      checkedLine,
      "expected a line reporting checked 15"
    ).toBeDefined();
  });

  it('"fuzz 0" is a benign edge — no crash; code 0/checked 0 OR a clean usage error', async () => {
    const res = await runHierarchyCommand(["fuzz", "0"], FAST);
    assertValidShape(res);
    expect([0, 1]).toContain(res.code);
    if (res.code === 0) {
      // If it ran, it must honestly report having checked 0 cases.
      const checkedLine = res.lines.find(
        (l) => /checked/i.test(l) && numbersIn(l).includes(0)
      );
      expect(checkedLine, "code 0 must report checked 0").toBeDefined();
    } else {
      // Otherwise a sensible usage / invalid-count message, never a raw crash.
      expect(
        res.lines.some((l) => /invalid|usage|count/i.test(l))
      ).toBe(true);
    }
  });
});

// -------------------------------------------------------------------------- //
// 6. stats ARITHMETIC (independent recomputation)
// -------------------------------------------------------------------------- //
describe("stats arithmetic matches an independent recomputation", () => {
  it('"stats 2 3" → workers 16 = 2^(3+1)', async () => {
    const expectedLeaves = Math.pow(2, 3 + 1); // 16
    const res = await runHierarchyCommand(["stats", "2", "3"], FAST);
    assertValidShape(res);
    expect(res.code).toBe(0);
    expect(expectedLeaves).toBe(16);
    const workerLine = res.lines.find((l) => /worker/i.test(l));
    expect(workerLine, "expected a workers line").toBeDefined();
    expect(numbersIn(workerLine!)).toContain(expectedLeaves);
  });

  it('"stats 3 1" → workers 9 = 3^(1+1)', async () => {
    const expectedLeaves = Math.pow(3, 1 + 1); // 9
    const res = await runHierarchyCommand(["stats", "3", "1"], FAST);
    assertValidShape(res);
    expect(res.code).toBe(0);
    expect(expectedLeaves).toBe(9);
    const workerLine = res.lines.find((l) => /worker/i.test(l));
    expect(workerLine, "expected a workers line").toBeDefined();
    expect(numbersIn(workerLine!)).toContain(expectedLeaves);
  });
});

// -------------------------------------------------------------------------- //
// 7. ARG PARSING ROBUSTNESS
// -------------------------------------------------------------------------- //
describe("arg parsing robustness — never crash on odd input", () => {
  it('"fuzz abc" (non-numeric) does not throw and yields a clean code (no NaN loop)', async () => {
    const res = await runHierarchyCommand(["fuzz", "abc"], FAST);
    assertValidShape(res);
    // Either a clean usage error (code 1) or a defaulted successful run (code 0),
    // but never a thrown exception and never a NaN-driven infinite loop.
    expect([0, 1]).toContain(res.code);
    if (res.code === 1) {
      expect(
        res.lines.some((l) => /invalid|usage|count/i.test(l))
      ).toBe(true);
    }
  });

  it('"stats" with no numbers uses defaults (4,3 → workers 256) without throwing', async () => {
    const expectedLeaves = Math.pow(4, 3 + 1); // 256
    const res = await runHierarchyCommand(["stats"], FAST);
    assertValidShape(res);
    expect(res.code).toBe(0);
    expect(expectedLeaves).toBe(256);
    const workerLine = res.lines.find((l) => /worker/i.test(l));
    expect(workerLine, "expected a workers line").toBeDefined();
    expect(numbersIn(workerLine!)).toContain(expectedLeaves);
  });
});
