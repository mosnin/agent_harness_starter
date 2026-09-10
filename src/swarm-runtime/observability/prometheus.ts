import type { SwarmMetrics } from "../types";

/**
 * Render {@link SwarmMetrics} in the Prometheus text exposition format, so a
 * standard Prometheus/OpenMetrics scraper can graph and alert on the swarm.
 * Pure — the server just serves this string at `GET /metrics`.
 */
export function formatPrometheus(m: SwarmMetrics, prefix = "swarm"): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number, labels?: Record<string, string>) => {
    const metric = `${prefix}_${name}`;
    lines.push(`# HELP ${metric} ${help}`);
    lines.push(`# TYPE ${metric} gauge`);
    const lbl = labels
      ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",")}}`
      : "";
    lines.push(`${metric}${lbl} ${value}`);
  };

  // Goals by status (labelled).
  lines.push(`# HELP ${prefix}_goals Goals by status`);
  lines.push(`# TYPE ${prefix}_goals gauge`);
  for (const [status, n] of Object.entries(m.goals)) {
    if (status === "total") continue;
    lines.push(`${prefix}_goals{status="${status}"} ${n}`);
  }
  gauge("goals_total", "Total goals", m.goals.total);

  lines.push(`# HELP ${prefix}_tasks Tasks by status`);
  lines.push(`# TYPE ${prefix}_tasks gauge`);
  for (const [status, n] of Object.entries(m.tasks)) {
    if (status === "total") continue;
    lines.push(`${prefix}_tasks{status="${status}"} ${n}`);
  }

  lines.push(`# HELP ${prefix}_workers Workers by status`);
  lines.push(`# TYPE ${prefix}_workers gauge`);
  for (const [status, n] of Object.entries(m.workers)) {
    if (status === "total") continue;
    lines.push(`${prefix}_workers{status="${status}"} ${n}`);
  }

  gauge("verifications_total", "Verification decisions", m.verification.total);
  gauge("verifications_accepted", "Accepted verifications", m.verification.accepted);
  gauge("verifications_rejected", "Rejected verifications", m.verification.rejected);
  gauge("verification_avg_score", "Average verification score 0..1", round(m.verification.avgScore));
  gauge("grounding_rate", "Fraction of accepted claims grounded in evidence", round(m.verification.groundingRate));
  gauge("tool_calls_total", "Total tool calls", m.usage.toolCalls);
  gauge("cost_usd_total", "Total USD cost", round(m.usage.costUsd, 6));

  return lines.join("\n") + "\n";
}

function round(x: number, places = 4): number {
  const f = 10 ** places;
  return Math.round((x || 0) * f) / f;
}
