/**
 * The real Hades gateway process: assembles every platform connector this
 * host has credentials for (never simulating the ones it doesn't), composes
 * them onto one {@link ConnectorHub}, and owns the process-lifecycle
 * primitives (start/stop idempotency, live counters, signal handling) the
 * `hades gateway` CLI command drives.
 *
 * Credential handling is strict: {@link buildConnectorsFromEnv} reports a
 * missing/incomplete platform's *variable names* only — a token, phone-id, or
 * URL value is never echoed into a probe, a status line, or a log line
 * anywhere in this module.
 *
 * @module hades/gateway/process
 */
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";
import { ConnectorHub } from "./connector";
import type { PlatformConnector, DeliveryTarget, Mirror } from "./connector";
import { RateLimiter } from "./rate-limiter";
import { withChunking } from "./chunked-delivery";
import { buildVoiceFromEnv } from "./voice-providers";
import { TelegramVoiceConnector, createTelegramVoiceHttpTransport } from "./connectors/telegram-voice";
import { DiscordConnector, createDiscordHttpTransport } from "./connectors/discord";
import { SlackConnector, createSlackHttpTransport } from "./connectors/slack";
import { WhatsAppConnector, createWhatsAppHttpTransport } from "./connectors/whatsapp";
import { SignalConnector, createSignalJsonRpcTransport } from "./connectors/signal";
import { EmailConnector, createEmailEnvTransport } from "./connectors/email";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One platform's connectivity verdict. `detail` names env VARIABLE NAMES
 * only — it is safe to print anywhere (CLI output, logs) and never carries a
 * credential value.
 */
export interface PlatformProbe {
  platform: string;
  mode: "real" | "offline";
  detail: string;
}

export interface GatewayStatus {
  running: boolean;
  startedAt?: number;
  platforms: PlatformProbe[];
  counters: { inbound: number; outbound: number; rateLimited: number };
}

export interface GatewayProcessOptions {
  handler: (msg: InboundMessage) => Promise<OutboundReply>;
  /** Credential source for {@link buildConnectorsFromEnv}. Ignored when both `connectors` and `report` are supplied. */
  env?: Record<string, string | undefined>;
  /** Explicit connector set — overrides env probing (tests, or a caller that already built its own set). */
  connectors?: PlatformConnector[];
  /** Explicit probe report to pair with `connectors` — overrides env probing. */
  report?: PlatformProbe[];
  log?: (line: string) => void;
  now?: () => number;
  /** Base per-key rate limiter. Default: 20 messages / 60s per `platform:user`. */
  rateLimiter?: RateLimiter;
}

// ---------------------------------------------------------------------------
// buildConnectorsFromEnv — the single source of truth for env → connectors
// ---------------------------------------------------------------------------

const PLATFORM_ORDER = ["telegram", "discord", "slack", "whatsapp", "signal", "email"] as const;

function missingList(names: string[]): string {
  return `missing ${names.join(", ")}`;
}

/** Probe a platform whose real transport needs exactly one token, with an optional legacy fallback var. */
function probeSingleVar(
  env: Record<string, string | undefined>,
  platform: string,
  primaryVar: string,
  fallbackVar: string | undefined,
  build: (value: string) => PlatformConnector
): { connector?: PlatformConnector; probe: PlatformProbe } {
  const primary = env[primaryVar];
  const fallback = fallbackVar ? env[fallbackVar] : undefined;
  if (primary) return { connector: build(primary), probe: { platform, mode: "real", detail: `via ${primaryVar}` } };
  if (fallback) return { connector: build(fallback), probe: { platform, mode: "real", detail: `via ${fallbackVar}` } };
  const names = fallbackVar ? [primaryVar, fallbackVar] : [primaryVar];
  return { probe: { platform, mode: "offline", detail: missingList(names) } };
}

/** Probe a platform whose real transport needs two vars, both required together. */
function probeDualVar(
  env: Record<string, string | undefined>,
  platform: string,
  varA: string,
  varB: string,
  build: (a: string, b: string) => PlatformConnector
): { connector?: PlatformConnector; probe: PlatformProbe } {
  const a = env[varA];
  const b = env[varB];
  if (a && b) return { connector: build(a, b), probe: { platform, mode: "real", detail: `via ${varA}, ${varB}` } };
  const missing = [varA, varB].filter((n) => !env[n]);
  return { probe: { platform, mode: "offline", detail: missingList(missing) } };
}

/**
 * Assemble every real-transport connector this environment has credentials
 * for; every platform in {@link PLATFORM_ORDER} always appears exactly once
 * in `report`, whether real or offline. Offline platforms are excluded from
 * `connectors` and never simulated — an absent credential means an absent
 * connector, full stop.
 */
export function buildConnectorsFromEnv(env: Record<string, string | undefined>): {
  connectors: PlatformConnector[];
  report: PlatformProbe[];
} {
  const results: Array<{ connector?: PlatformConnector; probe: PlatformProbe }> = [];

  // Telegram is the voice-capable connector: same long-poll text behavior as
  // TelegramConnector, plus real voice-note handling through the env-built
  // VoicePipeline (real Whisper STT with a key, else the self-announcing
  // "[mock]" transcriber; TTS only behind HADES_TTS_ENABLED=1 — see
  // ./voice-providers). The voice probe's stt/tts modes are folded into the
  // telegram probe detail so `gateway status`/`--probe` reports them; like
  // every other detail string, it carries env variable NAMES only.
  const voice = buildVoiceFromEnv(env);
  const telegram = probeSingleVar(env, "telegram", "HADES_TELEGRAM_TOKEN", "TELEGRAM_BOT_TOKEN", (token) =>
    new TelegramVoiceConnector(createTelegramVoiceHttpTransport(token), voice.pipeline)
  );
  if (telegram.probe.mode === "real") {
    telegram.probe = {
      ...telegram.probe,
      detail: `${telegram.probe.detail}; voice stt=${voice.probe.stt.mode}, tts=${voice.probe.tts.mode}`,
    };
  }
  results.push(telegram);
  results.push(
    probeSingleVar(env, "discord", "HADES_DISCORD_TOKEN", "DISCORD_BOT_TOKEN", (token) =>
      new DiscordConnector(createDiscordHttpTransport(token))
    )
  );
  results.push(
    probeSingleVar(env, "slack", "HADES_SLACK_TOKEN", "SLACK_BOT_TOKEN", (token) =>
      new SlackConnector(createSlackHttpTransport(token))
    )
  );
  results.push(
    probeDualVar(env, "whatsapp", "HADES_WHATSAPP_TOKEN", "HADES_WHATSAPP_PHONE_ID", (token, phoneId) =>
      new WhatsAppConnector(createWhatsAppHttpTransport(phoneId, token))
    )
  );
  results.push(
    probeDualVar(env, "signal", "HADES_SIGNAL_URL", "HADES_SIGNAL_NUMBER", (url, number) =>
      new SignalConnector(createSignalJsonRpcTransport(url, number))
    )
  );

  const email = createEmailEnvTransport(env);
  if (email.mode === "real" && email.transport && email.address) {
    results.push({
      connector: new EmailConnector(email.transport, { address: email.address }),
      probe: { platform: "email", mode: "real", detail: "via HADES_EMAIL_ADDRESS, HADES_EMAIL_IMAP_HOST, HADES_EMAIL_SMTP_HOST, HADES_EMAIL_USER, HADES_EMAIL_PASS" },
    });
  } else {
    results.push({ probe: { platform: "email", mode: "offline", detail: email.reason ?? "Email connector offline: missing HADES_EMAIL_* credentials" } });
  }

  // Preserve the canonical platform order regardless of the order pushed above.
  results.sort((a, b) => PLATFORM_ORDER.indexOf(a.probe.platform as (typeof PLATFORM_ORDER)[number]) - PLATFORM_ORDER.indexOf(b.probe.platform as (typeof PLATFORM_ORDER)[number]));

  const connectors = results.map((r) => r.connector).filter((c): c is PlatformConnector => c !== undefined);
  const report = results.map((r) => r.probe);
  return { connectors, report };
}

// ---------------------------------------------------------------------------
// CountingRateLimiter — wraps a RateLimiter to observe rejections
// ---------------------------------------------------------------------------

/**
 * `ConnectorHub` only mirrors traffic that clears the rate limiter (a
 * rejected message never reaches `route`'s mirror call), so counting
 * `rateLimited` traffic needs its own seam: this subclass delegates every
 * call to the real limiter it wraps and fires a callback exactly when a call
 * is rejected. It must subclass {@link RateLimiter} (not just structurally
 * match it) because `ConnectorHubOptions.rateLimiter` is typed as the
 * concrete class, and `RateLimiter`'s bucket/clock fields are private.
 */
class CountingRateLimiter extends RateLimiter {
  constructor(
    private readonly inner: RateLimiter,
    private readonly onRejected: () => void
  ) {
    super({ capacity: 1, refillMs: 1 }); // Base state is never touched; every call below delegates to `inner`.
  }

  override tryAcquire(key: string): boolean {
    const ok = this.inner.tryAcquire(key);
    if (!ok) this.onRejected();
    return ok;
  }

  override remaining(key: string): number {
    return this.inner.remaining(key);
  }
}

// ---------------------------------------------------------------------------
// GatewayProcess
// ---------------------------------------------------------------------------

/**
 * The gateway process: one {@link ConnectorHub} carrying every real
 * connector this host has credentials for, plus the lifecycle (idempotent
 * start/stop), live traffic counters, proactive delivery, and OS-signal
 * wiring the `hades gateway` CLI command needs.
 */
export class GatewayProcess {
  private readonly hub: ConnectorHub;
  private readonly report: PlatformProbe[];
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private running = false;
  private startedAt: number | undefined;
  private readonly counters = { inbound: 0, outbound: 0, rateLimited: 0 };

  constructor(private readonly opts: GatewayProcessOptions) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.now());

    const probed = buildConnectorsFromEnv(opts.env ?? {});
    const connectors = opts.connectors ?? probed.connectors;
    this.report = opts.report ?? probed.report;

    const baseLimiter = opts.rateLimiter ?? new RateLimiter({ capacity: 20, refillMs: 60_000 });
    const countingLimiter = new CountingRateLimiter(baseLimiter, () => {
      this.counters.rateLimited += 1;
    });

    const mirror: Mirror = (event) => {
      if (event.direction === "in") this.counters.inbound += 1;
      else this.counters.outbound += 1;
    };

    this.hub = new ConnectorHub(opts.handler, { rateLimiter: countingLimiter, mirror });
    // Chunking rides the wire for every connector — env-built or explicitly
    // supplied: a reply or proactive send longer than the platform's real
    // maxChars leaves as N marked, size-legal chunks instead of a raw blob
    // the platform API would reject or truncate. Idempotent (withChunking
    // never double-wraps), and byte-identical for under-limit text.
    for (const connector of withChunking(connectors)) this.hub.register(connector);
  }

  /** Idempotent: a second call while already running returns the current status without re-starting connectors. */
  async start(): Promise<GatewayStatus> {
    if (this.running) {
      this.log("gateway: start() called but already running — no-op");
      return this.status();
    }
    const real = this.report.filter((p) => p.mode === "real").map((p) => p.platform);
    const offline = this.report.filter((p) => p.mode === "offline").map((p) => p.platform);
    this.log(`gateway: starting ${this.hub.list().length} connector(s) — real: [${real.join(", ")}], offline: [${offline.join(", ")}]`);
    await this.hub.startAll();
    this.running = true;
    this.startedAt = this.now();
    this.log("gateway: started");
    return this.status();
  }

  /** Idempotent: a second call, or a call before `start`, resolves cleanly without re-stopping. Awaits every connector's `stop()`. */
  async stop(): Promise<void> {
    if (!this.running) {
      this.log("gateway: stop() called but not running — no-op");
      return;
    }
    this.log("gateway: stopping");
    await this.hub.stopAll();
    this.running = false;
    this.log("gateway: stopped");
  }

  status(): GatewayStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      platforms: this.report,
      counters: { ...this.counters },
    };
  }

  /** Proactively deliver to a platform. `false` (never a throw) when the platform is unregistered/offline. */
  async deliver(platform: string, target: DeliveryTarget, text: string): Promise<boolean> {
    const ok = await this.hub.deliver(platform, target, text);
    this.log(`gateway: deliver(${platform}) -> ${ok ? "sent" : "failed (unregistered/offline platform)"}`);
    return ok;
  }

  /**
   * Register SIGINT + SIGTERM handlers on `proc` that call `stop()`, and
   * return an uninstaller that removes exactly those two handlers. Never
   * touches the global `process` object unless the caller hands it in here.
   */
  installSignalHandlers(proc: { on(sig: string, cb: () => void): unknown }): () => void {
    const onSignal = (): void => {
      this.log("gateway: signal received — stopping");
      void this.stop();
    };
    proc.on("SIGINT", onSignal);
    proc.on("SIGTERM", onSignal);
    return () => {
      const removable = proc as unknown as {
        off?: (sig: string, cb: () => void) => unknown;
        removeListener?: (sig: string, cb: () => void) => unknown;
      };
      const remove = removable.off ?? removable.removeListener;
      remove?.call(proc, "SIGINT", onSignal);
      remove?.call(proc, "SIGTERM", onSignal);
    };
  }
}
