import { describe, it, expect } from "vitest";
import { AntiRogueGuardrail } from "../verification/guardrails";
import type { ToolCallRecord, WorkerResult } from "../types";

function result(trace: ToolCallRecord[], output: unknown = "ok"): WorkerResult {
  return {
    taskId: "t",
    workerId: "w",
    output,
    claims: [],
    toolTrace: trace,
    startedAt: 0,
    finishedAt: 1,
  };
}

function call(tool: string, args: Record<string, unknown>): ToolCallRecord {
  return { tool, args, ok: true, output: "", at: 0 };
}

describe("AntiRogueGuardrail — anti-rogue behaviour", () => {
  const guard = new AntiRogueGuardrail();

  it("kills a worker attempting to wipe the filesystem", () => {
    const findings = guard.inspect(result([call("shell", { cmd: "rm -rf /" })]));
    expect(AntiRogueGuardrail.worst(findings)).toBe("kill");
    expect(findings.some((f) => f.rule === "destructive-command")).toBe(true);
  });

  it("kills a worker exfiltrating credentials", () => {
    const findings = guard.inspect(result([call("shell", { cmd: "cat ~/.aws/credentials" })]));
    expect(AntiRogueGuardrail.worst(findings)).toBe("kill");
  });

  it("kills a worker trying to escape the sandbox via the docker socket", () => {
    const findings = guard.inspect(result([call("shell", { cmd: "curl --unix-socket /var/run/docker.sock http://x" })]));
    expect(AntiRogueGuardrail.worst(findings)).toBe("kill");
  });

  it("kills a worker trying to disable its own oversight", () => {
    const findings = guard.inspect(result([], "let me disable the guardrail and bypass verification"));
    expect(AntiRogueGuardrail.worst(findings)).toBe("kill");
  });

  it("flags a runaway loop", () => {
    const many = Array.from({ length: 300 }, () => call("noop", {}));
    const findings = guard.inspect(result(many));
    expect(findings.some((f) => f.rule === "runaway-loop")).toBe(true);
  });

  it("blocks use of an undeclared capability", () => {
    const g = new AntiRogueGuardrail({ allowedCapabilities: ["search"] });
    const findings = g.inspect(result([call("delete_database", {})]));
    expect(findings.some((f) => f.rule === "capability-escape")).toBe(true);
  });

  it("lets benign behaviour through", () => {
    const findings = guard.inspect(result([call("search", { q: "weather" }), call("read_file", { path: "a.md" })]));
    expect(AntiRogueGuardrail.worst(findings)).toBeNull();
  });
});
