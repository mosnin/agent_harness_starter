/**
 * Hades desktop — live V-TPH$ panel.
 *
 * V-TPH$ (Verified Tasks per Hour per Dollar) is the project's North Star: the
 * only throughput number that cannot be gamed, because it counts ONLY work an
 * independent ground-truth grader confirmed. This panel makes that metric
 * visible in the desktop app.
 *
 * Two exports, both pure and deterministic:
 *
 *  - {@link computeVtph} derives the headline number. It does NOT contain its
 *    own formula: it DELEGATES to the real benchmark harness
 *    ({@link runVtph} in `../../hades/bench/vtph`). See {@link deriveReport} for
 *    exactly how the panel's flat inputs are adapted to that harness.
 *  - {@link renderVtphPanel} renders theme-tokened HTML. It never fabricates a
 *    figure: when the inputs are insufficient to compute an honest V-TPH$
 *    (no spend, no elapsed time, or nothing verified yet) it shows "n/a" /
 *    "awaiting a verified run" instead of a made-up value.
 *
 * Framework-light like the rest of `../ui/*`: no `window`, no IPC, no timers,
 * no DOM. The native shell owns mounting the returned string.
 *
 * ## Why these functions are async
 *
 * `bench/vtph.ts` exposes its V-TPH$ computation ONLY through `runVtph`, which
 * is `async` (it runs a bounded-concurrency batch). There is no exported sync
 * pure formula to import. To honor "reuse the real computation, do not invent a
 * parallel formula", both {@link computeVtph} and {@link renderVtphPanel}
 * delegate to `runVtph` and are therefore async. This is a deliberate trade-off
 * documented in the build report: correctness of the metric (single source of
 * truth) is worth more than a synchronous render signature.
 */

import { runVtph, type AgentRunner, type EvalTask, type VtphReport } from "../../hades/bench/vtph";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The inputs the panel derives from. These map directly onto fields already
 * present in the swarm's live metrics stream (see `MetricsView.verifiedTasks`,
 * `MetricsView.costUsd`) plus wall-clock elapsed time and a rolling history of
 * prior V-TPH$ samples for the sparkline.
 */
export interface VtphInput {
  /** Independently-verified task count so far (the ONLY work that scores). */
  verifiedTasks: number;
  /** Wall-clock elapsed for the run, in milliseconds. */
  elapsedMs: number;
  /** LLM spend for the run, in USD. */
  costUsd: number;
  /** Rolling prior V-TPH$ samples, oldest first, for the sparkline. */
  history: number[];
}

/** Why the panel could not produce an honest number (or `"ok"` when it could). */
export type VtphReason = "ok" | "no-cost" | "no-elapsed" | "no-verified";

/** The derived, display-ready V-TPH$ figures. `null` = insufficient data. */
export interface VtphComputed {
  /** The North Star: verified tasks per hour per dollar. `null` if insufficient. */
  vtphd: number | null;
  /** Verified tasks per hour (before the per-dollar normalization). `null` if insufficient. */
  vtph: number | null;
  verifiedTasks: number;
  costUsd: number;
  elapsedMs: number;
  reason: VtphReason;
}

// ---------------------------------------------------------------------------
// Computation — delegates to bench/vtph.ts
// ---------------------------------------------------------------------------

function insufficient(input: VtphInput, reason: VtphReason): VtphComputed {
  return {
    vtphd: null,
    vtph: null,
    verifiedTasks: input.verifiedTasks,
    costUsd: input.costUsd,
    elapsedMs: input.elapsedMs,
    reason,
  };
}

/**
 * Adapt the panel's flat inputs onto {@link runVtph} and return its real
 * {@link VtphReport}. This is the ONLY place a V-TPH$ number is produced, and
 * it produces it by running the actual harness — no parallel formula.
 *
 * The adaptation is faithful to how `runVtph` aggregates a batch:
 *   - `verifiedTasks` synthetic tasks are created, each graded `true`, and the
 *     runner claims each `verified` — so every one lands in `verifiedCorrect`
 *     (the exact bucket that scores). `verifiedCorrect` therefore equals
 *     `verifiedTasks`.
 *   - The full `costUsd` is attributed to the first task (the rest cost 0), so
 *     `runVtph`'s summed `totalUsd` is exactly `costUsd` with no float drift.
 *   - `now()` is injected to return 0 on the first sample and `elapsedMs` on the
 *     second; `runVtph` samples the clock exactly once before and once after the
 *     batch, so its `wallClockMs` is exactly `elapsedMs`.
 *
 * Given those three, `runVtph` computes `vtph = verifiedCorrect / (wallClockMs /
 * 3_600_000)` and `vtphPerDollar = vtph / max(totalUsd, 1e-9)` — precisely the
 * North Star, straight from the harness.
 */
async function deriveReport(
  verifiedTasks: number,
  elapsedMs: number,
  costUsd: number
): Promise<VtphReport> {
  const n = Math.max(0, Math.floor(verifiedTasks));
  const tasks: EvalTask[] = Array.from({ length: n }, (_, i) => ({
    id: `vtph-panel-${i}`,
    prompt: "",
    category: "synthetic",
    decomposable: false,
    grade: () => true,
  }));

  const runner: AgentRunner = async (task) => ({
    output: "",
    claimedVerified: true,
    tokensIn: 0,
    tokensOut: 0,
    usd: task.id === "vtph-panel-0" ? costUsd : 0,
    provenance: [],
  });

  let sample = 0;
  const now = () => (sample++ === 0 ? 0 : elapsedMs);

  return runVtph(runner, tasks, { label: "vtph-panel", now });
}

/**
 * Compute the panel's V-TPH$ figures from `input`, delegating the arithmetic to
 * the real {@link runVtph} harness (see {@link deriveReport}).
 *
 * Returns honest `null`s (never a fabricated 0 or placeholder) when the inputs
 * cannot support a real number:
 *   - `costUsd <= 0`     -> `"no-cost"`     (cannot divide verified work by spend)
 *   - `elapsedMs <= 0`   -> `"no-elapsed"`  (no wall-clock to normalize against)
 *   - `verifiedTasks<=0` -> `"no-verified"` (nothing has passed verification yet)
 *
 * Non-finite inputs (NaN/Infinity) fail the `> 0` guards and are treated as
 * insufficient as well.
 */
export async function computeVtph(input: VtphInput): Promise<VtphComputed> {
  const { verifiedTasks, elapsedMs, costUsd } = input;

  // Guards use Number.isFinite so +Infinity is rejected too — an infinite
  // elapsed/cost would divide to a fabricated 0, and an infinite task count
  // would throw in the harness. Insufficient/ill-formed data must never
  // produce a made-up number.
  if (!(Number.isFinite(costUsd) && costUsd > 0)) return insufficient(input, "no-cost");
  if (!(Number.isFinite(elapsedMs) && elapsedMs > 0)) return insufficient(input, "no-elapsed");
  if (!(Number.isFinite(verifiedTasks) && verifiedTasks > 0)) return insufficient(input, "no-verified");

  const report = await deriveReport(verifiedTasks, elapsedMs, costUsd);

  return {
    vtphd: report.vtphPerDollar,
    vtph: report.vtph,
    verifiedTasks,
    costUsd,
    elapsedMs,
    reason: "ok",
  };
}

// ---------------------------------------------------------------------------
// Rendering — pure, theme-tokened, no fabricated numbers
// ---------------------------------------------------------------------------

/** Eight block-height glyphs, low to high, for a deterministic sparkline. */
const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Render a deterministic block sparkline from a history of V-TPH$ samples.
 * Each sample is scaled against the max of the series onto one of eight glyph
 * heights; the same history always yields the same string. Empty history is an
 * honest placeholder, not zeroed bars.
 */
function renderSparkline(history: number[]): string {
  const finite = history.filter((v) => Number.isFinite(v) && v >= 0);
  if (finite.length === 0) {
    return `<span class="vtph-spark vtph-spark--empty">no samples yet</span>`;
  }
  const max = Math.max(...finite);
  const bars = finite
    .map((v) => {
      if (!(max > 0)) return SPARK_BLOCKS[0];
      const level = Math.round((v / max) * (SPARK_BLOCKS.length - 1));
      return SPARK_BLOCKS[Math.min(SPARK_BLOCKS.length - 1, Math.max(0, level))];
    })
    .join("");
  return `<span class="vtph-spark" aria-label="V-TPH$ history">${bars}</span>`;
}

function formatUsd(usd: number): string {
  return Number.isFinite(usd) ? `$${usd.toFixed(4)}` : "n/a";
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "n/a";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(2)}h`;
}

function formatCount(n: number): string {
  return Number.isFinite(n) ? String(Math.max(0, Math.floor(n))) : "n/a";
}

/** The honest fallback message for each insufficient-data reason. */
function awaitingMessage(reason: VtphReason): string {
  switch (reason) {
    case "no-verified":
      return "awaiting a verified run";
    case "no-cost":
      return "n/a (awaiting spend)";
    case "no-elapsed":
      return "n/a (awaiting elapsed time)";
    default:
      return "n/a";
  }
}

function metricRow(label: string, value: string): string {
  return (
    `<div class="vtph-metric">` +
    `<span class="vtph-metric-label">${label}</span>` +
    `<span class="vtph-metric-value">${value}</span>` +
    `</div>`
  );
}

/**
 * Render the live V-TPH$ panel as a pure HTML string.
 *
 * Shows the current V-TPH$ (or an honest "n/a" / "awaiting a verified run" when
 * inputs are insufficient), the inputs it derives from (verified tasks, spend,
 * elapsed), a deterministic block sparkline of the history, and a one-line
 * caption stating what V-TPH$ is and that lying "verified" scores 0.
 *
 * Async because it delegates the headline number to the async `runVtph`
 * harness (see the module header). Pass `null` to render the pre-run empty
 * state.
 */
export async function renderVtphPanel(input: VtphInput | null): Promise<string> {
  const computed = input ? await computeVtph(input) : null;

  const headline =
    computed && computed.vtphd !== null
      ? `<span class="vtph-value">${computed.vtphd.toFixed(2)}</span>` +
        `<span class="vtph-unit">V-TPH$</span>`
      : `<span class="vtph-value vtph-value--na">` +
        `${computed ? awaitingMessage(computed.reason) : "awaiting a verified run"}` +
        `</span>`;

  const verified = computed ? formatCount(computed.verifiedTasks) : "0";
  const spend = computed ? formatUsd(computed.costUsd) : "n/a";
  const elapsed = computed ? formatElapsed(computed.elapsedMs) : "n/a";
  const spark = renderSparkline(input ? input.history : []);

  return `
    <section class="vtph-panel" aria-label="V-TPH$ (Verified Tasks per Hour per Dollar)"
      style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:var(--space-lg);color:var(--color-ink)">
      <header class="vtph-panel-head">
        <h2 class="vtph-panel-title" style="color:var(--color-ink);font-family:var(--type-family-display)">V-TPH$</h2>
        <p class="vtph-panel-subtitle" style="color:var(--color-ink-secondary);font-size:var(--type-size-xs)">North Star: Verified Tasks per Hour per Dollar</p>
      </header>
      <div class="vtph-headline" style="color:var(--color-accent)">
        ${headline}
      </div>
      <div class="vtph-metrics">
        ${metricRow("Verified tasks", verified)}
        ${metricRow("Spent", spend)}
        ${metricRow("Elapsed", elapsed)}
      </div>
      <div class="vtph-sparkline" style="color:var(--color-accent);font-family:var(--type-family-mono)">
        ${spark}
      </div>
      <p class="vtph-caption" style="color:var(--color-ink-tertiary);font-size:var(--type-size-2xs)">
        V-TPH$ counts only independently verified work. Claiming "verified" on a wrong answer scores 0, so the metric cannot be gamed.
      </p>
    </section>
  `.trim();
}
