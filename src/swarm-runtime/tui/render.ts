import type { SwarmMetrics } from "../types";

/** The subset of a dashboard snapshot the TUI renders. */
export interface TuiState {
  mode?: string;
  metrics?: SwarmMetrics;
  workers?: Array<{ workerId: string; status: string; capabilities?: string[] }>;
  tasks?: Array<{ description: string; status: string }>;
  logs?: Array<{ workerId: string; line: string }>;
  groundingRate?: number;
}

const BAR_WIDTH = 20;

/**
 * Render a swarm snapshot to a plain-text terminal view. Pure (no I/O, no
 * colors that would break assertions) so it's unit-testable; the CLI wraps it in
 * a poll loop and screen clears. This is the lightweight terminal counterpart to
 * the web dashboard — Hermes-style "a real terminal interface".
 */
export function renderTui(state: TuiState, width = 72): string {
  const line = "─".repeat(width);
  const out: string[] = [];
  const m = state.metrics;

  out.push(`╭${line}╮`);
  out.push(pad(`  HERMES·SWARM   mode=${state.mode ?? "?"}   grounded=${pct(m?.verification.groundingRate ?? state.groundingRate ?? 0)}`, width));
  out.push(`├${line}┤`);

  if (m) {
    out.push(pad(`  goals ${m.goals.completed}/${m.goals.total} done · ${m.goals.running} running · ${m.goals.failed} failed · ${m.goals.aborted} aborted`, width));
    out.push(pad(`  tasks ${m.tasks.verified} verified · ${m.tasks.dispatched} running · ${m.tasks.pending} pending · ${m.tasks.failed} failed`, width));
    out.push(pad(`  verify ${meter(m.verification.accepted, m.verification.accepted + m.verification.rejected)} accepted (avg ${pct(m.verification.avgScore)})`, width));
    out.push(pad(`  usage ${m.usage.toolCalls} tool calls · $${m.usage.costUsd.toFixed(4)}`, width));
    out.push(`├${line}┤`);
  }

  out.push(pad(`  WORKERS (${(state.workers ?? []).length})`, width));
  for (const w of state.workers ?? []) {
    out.push(pad(`    ${statusIcon(w.status)} ${w.workerId}  ${w.status}  [${(w.capabilities ?? []).join(",")}]`, width));
  }

  out.push(`├${line}┤`);
  out.push(pad(`  TASKS (${(state.tasks ?? []).length})`, width));
  for (const t of (state.tasks ?? []).slice(0, 8)) {
    out.push(pad(`    ${statusIcon(t.status)} ${t.status.padEnd(11)} ${truncate(t.description, width - 22)}`, width));
  }

  const logs = state.logs ?? [];
  if (logs.length) {
    out.push(`├${line}┤`);
    out.push(pad(`  RECENT`, width));
    for (const l of logs.slice(-5)) out.push(pad(`    ${truncate(`[${l.workerId}] ${l.line}`, width - 6)}`, width));
  }

  out.push(`╰${line}╯`);
  return out.join("\n");
}

function meter(ok: number, total: number): string {
  const filled = total ? Math.round((ok / total) * BAR_WIDTH) : 0;
  return `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}] ${ok}/${total}`;
}

function statusIcon(status: string): string {
  switch (status) {
    case "verified":
    case "idle":
      return "●";
    case "busy":
    case "dispatched":
    case "reported":
      return "◐";
    case "failed":
    case "killed":
    case "dead":
      return "✗";
    default:
      return "○";
  }
}

function pct(x: number): string {
  return `${Math.round((x || 0) * 100)}%`;
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}
function pad(s: string, width: number): string {
  const visible = [...s].length;
  const inner = width;
  const content = visible > inner ? truncate(s, inner) : s + " ".repeat(inner - visible);
  return `│${content}│`;
}
