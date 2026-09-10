/**
 * The live gateway TUI session behind `hades gateway start --tui`: composes
 * the real env-built connectors + {@link ConnectorHub} with a {@link Mirror}
 * that feeds every genuine inbound/outbound event into the TUI's GATEWAY
 * pane, and a real {@link BadgeStamper}/{@link assessReply} verdict for every
 * reply into the pane's BADGES tally — closing the "live TRAFFIC/BADGES
 * feed" gap the pane shipped with (it could render rows, nothing fed it any).
 *
 * This module owns exactly one thing: wiring already-real pieces together
 * honestly. It never invents a traffic row, never invents a badge, and never
 * touches a terminal directly — `paint` is fully injected, so nothing here
 * calls `process.stdout` or schedules real timers unless the caller lets the
 * defaults do so.
 *
 * ## Wiring
 *
 * ```
 * buildConnectorsFromEnv/opts.connectors ─┐
 *                                          ├─▶ withChunking ─▶ ConnectorHub
 *                        opts.rateLimiter ─┘         │  (mirror + route)
 *                                                     ▼
 *                                    mirrorEventToTrafficRow ─▶ TuiApp.applyGatewayTraffic
 *                                                     │
 *                                          opts.handler(msg) ─▶ assessReply (± BadgeStamper)
 *                                                     ▼
 *                                          TuiApp.applyGatewayBadge
 * ```
 *
 * A coalescing repaint timer (`opts.timers`, default `repaintMs` = 100ms)
 * calls `opts.paint(app.frame())` only when real state actually changed
 * since the last paint — an idle gateway never re-paints.
 *
 * @module hades/cli/gateway-tui
 */
import { buildConnectorsFromEnv, type PlatformProbe } from "../gateway/process";
import { ConnectorHub, type Mirror, type PlatformConnector } from "../gateway/connector";
import { withChunking } from "../gateway/chunked-delivery";
import { RateLimiter } from "../gateway/rate-limiter";
import { BadgeStamper, assessReply, type TrustBadge, type BadgeEvidence } from "../gateway/badge";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";
import { TuiApp, type GatewayPaneTrafficRow, type GatewayPaneProbeRow } from "../../swarm-runtime/tui";

// ---------------------------------------------------------------------------
// Pure adapters
// ---------------------------------------------------------------------------

/** A raw mirror event, exactly as {@link Mirror} delivers it. */
interface MirrorEvent {
  direction: "in" | "out";
  platform: string;
  user: string;
  text: string;
}

/**
 * Preview width for a traffic row's text, in Unicode code points. Chosen
 * comfortably under the pane's own render-time cap (200, see
 * `gateway-pane.ts`'s `sane(row.preview, 200)`) so a row this module hands
 * the pane is already honestly short — the pane's own clamp is only ever a
 * no-op safety net for text produced here, never the thing doing the actual
 * truncating.
 */
const TRAFFIC_PREVIEW_WIDTH = 160;

/**
 * Truncate `text` to at most `maxCodePoints` Unicode code points (never
 * splitting a surrogate pair), appending a single trailing "…" exactly when
 * truncation actually removed something — an honest ellipsis, never silently
 * dropped text with no indication it was cut.
 */
function truncateHonestly(text: string, maxCodePoints: number): string {
  const cps = [...text];
  if (cps.length <= maxCodePoints) return text;
  if (maxCodePoints <= 1) return "…";
  return cps.slice(0, maxCodePoints - 1).join("") + "…";
}

/**
 * Adapt one real {@link Mirror} event into a {@link GatewayPaneTrafficRow}.
 * Pure: no clock/global reads (the timestamp is the caller-supplied
 * `nowMs`), no mutation of `e`, deterministic for identical inputs.
 * `direction`/`platform`/`user` pass through unchanged; `text` is truncated
 * to {@link TRAFFIC_PREVIEW_WIDTH} code points with an honest ellipsis.
 */
export function mirrorEventToTrafficRow(e: MirrorEvent, nowMs: number): GatewayPaneTrafficRow {
  return {
    direction: e.direction,
    platform: e.platform,
    user: e.user,
    preview: truncateHonestly(e.text, TRAFFIC_PREVIEW_WIDTH),
    at: nowMs,
  };
}

/**
 * Adapt real {@link PlatformProbe} rows (from {@link buildConnectorsFromEnv}
 * or an explicit `report`) into the pane's `GatewayPaneProbeRow` shape.
 * `PlatformProbe` and `GatewayPaneProbeRow` are already field-identical
 * (`platform`/`mode`/`detail`) — this copies rather than aliases so the
 * pane's snapshot can never be mutated through a reference the caller still
 * holds. An "offline" probe always maps to `mode: "offline"`; it can never
 * be rendered as though it were live.
 */
export function probesToPaneRows(probes: PlatformProbe[]): GatewayPaneProbeRow[] {
  return probes.map((p) => ({ platform: p.platform, mode: p.mode, detail: p.detail }));
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Minimal injectable timer surface — real `setInterval`/`clearInterval` by default, counting fakes in tests. */
export interface GatewayTuiTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface GatewayTuiSessionOptions {
  /** The real reply handler (agent/swarm entry point). May optionally attach `evidence` to its reply — see badge assessment below — but its declared return type is the plain gateway `OutboundReply`. */
  handler: (msg: InboundMessage) => Promise<OutboundReply>;
  /** Credential source for {@link buildConnectorsFromEnv}. Ignored when `connectors` is supplied. */
  env?: Record<string, string | undefined>;
  /** Explicit connector set — overrides env probing (tests, or a caller with its own set). */
  connectors?: PlatformConnector[];
  /** Explicit probe report to seed the PLATFORMS pane with — overrides env probing. */
  report?: PlatformProbe[];
  /** The TUI app to drive. A fresh `TuiApp` is created when omitted. */
  app?: TuiApp;
  /** Called with the rendered frame on a real state change. Never called from an idle tick. Fully injected — this module never touches `process.stdout`. */
  paint?: (frame: string) => void;
  /** Width for a freshly-created `TuiApp` (ignored when `app` is supplied). */
  width?: number;
  /** Injectable clock for traffic-row timestamps. Default `Date.now`. */
  now?: () => number;
  /** Injectable timer surface for the coalescing repaint loop. Default real `setInterval`/`clearInterval`. */
  timers?: GatewayTuiTimers;
  /** Repaint coalescing interval in ms. Default 100. */
  repaintMs?: number;
  /** Per-key rate limiter passed straight to `ConnectorHub`. Omitted = no rate limiting. */
  rateLimiter?: RateLimiter;
  /** Real badge stamper used to render the outbound wire text's badge line. Omitted = replies leave unstamped (the pane's BADGES tally is unaffected either way — it always reflects the real `assessReply` verdict). */
  badgeStamper?: BadgeStamper;
  /** Diagnostic/error log sink. Default no-op. Never receives a credential value. */
  log?: (line: string) => void;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ZERO_BADGE_TALLY = (): Record<TrustBadge, number> => ({ verified: 0, abstained: 0, unverified: 0 });

/**
 * A live `hades gateway start --tui` session: one real `ConnectorHub` wired
 * to every connector this environment (or the caller) actually has, whose
 * traffic mirrors and reply-badge verdicts drive a `TuiApp`'s GATEWAY pane
 * with a throttled, coalescing repaint.
 */
export class GatewayTuiSession {
  private readonly opts: GatewayTuiSessionOptions;
  private readonly appInstance: TuiApp;
  private readonly hub: ConnectorHub;
  private readonly report: PlatformProbe[];
  private readonly now: () => number;
  private readonly timers: GatewayTuiTimers;
  private readonly repaintMs: number;
  private readonly log: (line: string) => void;

  private running = false;
  private dirty = false;
  private intervalHandle: unknown = undefined;
  private readonly tally = { inbound: 0, outbound: 0, badges: ZERO_BADGE_TALLY() };

  constructor(opts: GatewayTuiSessionOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    this.timers =
      opts.timers ??
      {
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
        clearInterval: (h: unknown) => clearInterval(h as NodeJS.Timeout),
      };
    this.repaintMs = opts.repaintMs ?? 100;
    this.appInstance = opts.app ?? new TuiApp({ width: opts.width });

    const probed = buildConnectorsFromEnv(opts.env ?? {});
    const connectors = opts.connectors ?? probed.connectors;
    this.report = opts.report ?? probed.report;

    const mirror: Mirror = (event) => {
      if (event.direction === "in") this.tally.inbound += 1;
      else this.tally.outbound += 1;
      const row = mirrorEventToTrafficRow(event, this.now());
      this.appInstance.applyGatewayTraffic(row);
      this.markDirty();
    };

    this.hub = new ConnectorHub((msg) => this.assessAndRoute(msg), {
      mirror,
      rateLimiter: opts.rateLimiter,
    });

    for (const connector of withChunking(connectors)) this.hub.register(connector);
  }

  /**
   * The hub's routed handler: runs the real `opts.handler` exactly once,
   * then honestly assesses whatever reply it produced.
   *
   * - A throwing handler is caught, logged, and degrades to an unaccepted
   *   empty-text reply — the exchange is never shown as a successful badged
   *   reply, and the session stays alive for the next message. (The
   *   inbound side of this exchange was already mirrored by `ConnectorHub`
   *   before this method ran; only the outbound leg is honestly absent.)
   * - An empty-text reply (ignored/unauthorized message) is never assessed
   *   or badged — same convention `BadgeStamper.wrap` uses.
   * - A non-empty reply is assessed via the real `assessReply` against its
   *   *own* pre-stamp text and evidence (mirroring `BadgeStamper.wrap`'s own
   *   internal order), and the resulting `TrustBadge` — never invented —
   *   drives `TuiApp.applyGatewayBadge`. When `opts.badgeStamper` is
   *   supplied, the *outbound wire text* is additionally re-rendered through
   *   it (a fresh trivial re-wrap over the already-computed reply, so the
   *   real handler is never invoked twice) so the platform sees the same
   *   badge line a live gateway would actually send.
   */
  private async assessAndRoute(msg: InboundMessage): Promise<OutboundReply> {
    let raw: OutboundReply & { evidence?: BadgeEvidence };
    try {
      raw = await (
        this.opts.handler as (m: InboundMessage) => Promise<OutboundReply & { evidence?: BadgeEvidence }>
      )(msg);
    } catch (err) {
      this.log(`gateway-tui: handler threw for ${msg.platform}:${msg.user} — ${describeError(err)}`);
      return { text: "", accepted: false };
    }

    if (!raw.text) {
      return { text: raw.text, goalId: raw.goalId, status: raw.status, accepted: raw.accepted };
    }

    const stamped = await assessReply(raw.text, raw.evidence ?? {});
    this.recordBadge(stamped.badge);

    if (this.opts.badgeStamper) {
      const capturedRaw = raw;
      return this.opts.badgeStamper.wrap(async () => capturedRaw)(msg);
    }

    return { text: raw.text, goalId: raw.goalId, status: raw.status, accepted: raw.accepted };
  }

  private recordBadge(badge: TrustBadge): void {
    this.tally.badges[badge] += 1;
    this.appInstance.applyGatewayBadge(badge);
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private tick(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.opts.paint?.(this.appInstance.frame());
  }

  /**
   * Start every connector and the coalescing repaint timer. Idempotent: a
   * second call while already running logs a no-op and returns the current
   * snapshot without re-starting anything or re-registering the timer.
   */
  async start(): Promise<{ platforms: PlatformProbe[]; connectors: number }> {
    if (this.running) {
      this.log("gateway-tui: start() called but already running — no-op");
      return { platforms: this.report, connectors: this.hub.list().length };
    }

    // Seed the PLATFORMS section with the real probe report. Counters start
    // genuinely at zero (nothing has happened yet) — never re-derived here
    // afterward, so this module never claims a rate-limited count it doesn't
    // track.
    this.appInstance.applyGatewayStatus({
      probes: probesToPaneRows(this.report),
      counters: { inbound: 0, outbound: 0, rateLimited: 0 },
    });

    await this.hub.startAll();
    this.running = true;
    this.intervalHandle = this.timers.setInterval(() => this.tick(), this.repaintMs);
    this.log(`gateway-tui: started ${this.hub.list().length} connector(s)`);
    return { platforms: this.report, connectors: this.hub.list().length };
  }

  /**
   * Stop every connector and the repaint timer. Idempotent: a second call,
   * or a call before `start`, resolves cleanly as a no-op. After this
   * resolves, no further paint can occur and no further inbound event can
   * mutate session state (each connector's own `stop()` detaches its
   * handler).
   */
  async stop(): Promise<void> {
    if (!this.running) {
      this.log("gateway-tui: stop() called but not running — no-op");
      return;
    }
    if (this.intervalHandle !== undefined) {
      this.timers.clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    await this.hub.stopAll();
    this.running = false;
    this.dirty = false;
    this.log("gateway-tui: stopped");
  }

  /** The `TuiApp` this session drives (for reading `frame()`/`gatewayState()` directly, e.g. in tests). */
  app(): TuiApp {
    return this.appInstance;
  }

  /** Real, cumulative counters — always exactly consistent with `app().gatewayState()`'s TRAFFIC/BADGES sections. */
  counters(): { inbound: number; outbound: number; badges: Record<TrustBadge, number> } {
    return { inbound: this.tally.inbound, outbound: this.tally.outbound, badges: { ...this.tally.badges } };
  }
}
