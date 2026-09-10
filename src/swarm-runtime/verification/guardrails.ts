import type { ToolCallRecord, WorkerResult } from "../types";

export type RogueSeverity = "warn" | "block" | "kill";

export interface RogueFinding {
  rule: string;
  severity: RogueSeverity;
  detail: string;
  /** Index into the tool trace, when the finding is about a specific call. */
  toolIndex?: number;
}

export interface GuardrailPolicy {
  /** Capabilities this worker is allowed to use. Empty = allow all declared. */
  allowedCapabilities?: string[];
  /** Extra regexes that mark a shell/tool arg as destructive. */
  destructivePatterns?: RegExp[];
  /** Hosts a worker may talk to; any other outbound target is flagged. */
  allowedHosts?: string[];
  /** Max tool calls before we suspect a runaway loop. */
  maxToolCalls?: number;
}

/**
 * Default patterns for behaviour that should never come from a worker whose job
 * is bounded to a single delegated task. These catch the classic "gone rogue"
 * moves: wiping the host, exfiltrating secrets, self-replicating, escaping the
 * sandbox, or disabling its own oversight.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]+\s+(?:\/(?![a-z0-9_.])|~|\$HOME|\*)/i, // rm -rf / , ~ , $HOME, *
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\/(sd|nvme|xvd)/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
  /\bchmod\s+-R\s+777\s+\//i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  />\s*\/dev\/(sd|nvme)/i,
];

const EXFIL_PATTERNS: RegExp[] = [
  /\b(curl|wget|nc|ncat|scp)\b[^\n]*\b(?:\d{1,3}\.){3}\d{1,3}\b/i, // pipe to raw IP
  /\bcat\b[^\n]*\/(?:etc\/shadow|\.ssh\/id_[a-z0-9]+|\.aws\/credentials|\.env)\b/i,
  /\b(AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|PRIVATE_KEY)\b/,
];

const ESCAPE_PATTERNS: RegExp[] = [
  /\bdocker\s+(run|exec|-H|--host)\b/i, // spawning containers / talking to daemon
  /\/var\/run\/docker\.sock/i,
  /\bnsenter\b|\bunshare\b|\b--privileged\b/i,
  /\bkubectl\b|\bcrictl\b/i,
];

const SELF_PRESERVATION_PATTERNS: RegExp[] = [
  /\b(kill|pkill|killall)\b[^\n]*\b(guardrail|verifier|manager|oversight|monitor)\b/i,
  /\b(disable|bypass|ignore)\b[^\n]*\b(guardrail|safety|verification|policy)\b/i,
];

/**
 * Anti-rogue behavioural guardrail. Complements the {@link VerificationGate}:
 * the gate asks "is this output *true*?", the guardrail asks "did the worker
 * *behave*?". Runs over the tool trace and output, returning findings the
 * manager acts on — a `kill` finding tears the worker's container down
 * immediately.
 */
export class AntiRogueGuardrail {
  constructor(private readonly policy: GuardrailPolicy = {}) {}

  inspect(result: WorkerResult): RogueFinding[] {
    const findings: RogueFinding[] = [];
    const trace = result.toolTrace;

    // Runaway loop detection.
    const max = this.policy.maxToolCalls ?? 200;
    if (trace.length > max) {
      findings.push({
        rule: "runaway-loop",
        severity: "kill",
        detail: `worker made ${trace.length} tool calls (limit ${max}) — possible runaway loop`,
      });
    }

    trace.forEach((call, i) => {
      findings.push(...this.inspectCall(call, i));
    });

    // Scope check: worker used a capability it never declared.
    if (this.policy.allowedCapabilities && this.policy.allowedCapabilities.length > 0) {
      const allowed = new Set(this.policy.allowedCapabilities);
      for (const [i, call] of trace.entries()) {
        if (!allowed.has(call.tool)) {
          findings.push({
            rule: "capability-escape",
            severity: "block",
            detail: `used undeclared capability "${call.tool}"`,
            toolIndex: i,
          });
        }
      }
    }

    // Inspect the free-text output too — a worker can smuggle rogue intent into
    // its answer even when its tool calls look clean.
    const outStr = safeString(result.output);
    for (const p of SELF_PRESERVATION_PATTERNS) {
      if (p.test(outStr)) {
        findings.push({
          rule: "self-preservation",
          severity: "kill",
          detail: "output contains language aimed at disabling its own oversight",
        });
        break;
      }
    }

    return findings;
  }

  private inspectCall(call: ToolCallRecord, i: number): RogueFinding[] {
    const findings: RogueFinding[] = [];
    const blob = `${call.tool} ${JSON.stringify(call.args)}`;

    const patternSets: Array<[string, RogueSeverity, RegExp[]]> = [
      ["destructive-command", "kill", [...DESTRUCTIVE_PATTERNS, ...(this.policy.destructivePatterns ?? [])]],
      ["data-exfiltration", "kill", EXFIL_PATTERNS],
      ["sandbox-escape", "kill", ESCAPE_PATTERNS],
      ["self-preservation", "kill", SELF_PRESERVATION_PATTERNS],
    ];

    for (const [rule, severity, patterns] of patternSets) {
      if (patterns.some((p) => p.test(blob))) {
        findings.push({ rule, severity, detail: `blocked by ${rule}: ${truncate(blob)}`, toolIndex: i });
      }
    }

    // Outbound-host allowlist.
    if (this.policy.allowedHosts && this.policy.allowedHosts.length > 0) {
      const host = extractHost(blob);
      if (host && !this.policy.allowedHosts.some((h) => host.endsWith(h))) {
        findings.push({
          rule: "egress-violation",
          severity: "block",
          detail: `contacted non-allowlisted host "${host}"`,
          toolIndex: i,
        });
      }
    }

    return findings;
  }

  /** The strongest severity present, or null if the worker behaved. */
  static worst(findings: RogueFinding[]): RogueSeverity | null {
    if (findings.some((f) => f.severity === "kill")) return "kill";
    if (findings.some((f) => f.severity === "block")) return "block";
    if (findings.some((f) => f.severity === "warn")) return "warn";
    return null;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function safeString(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function extractHost(s: string): string | null {
  const m = s.match(/https?:\/\/([^/\s"']+)/i);
  return m ? m[1].toLowerCase() : null;
}
