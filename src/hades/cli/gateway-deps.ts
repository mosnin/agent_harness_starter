/**
 * Composes the real `hades gateway` pipeline: pairing → continuity → badges
 * → agent, in that locked order, wired onto a {@link GatewayProcess}.
 *
 * The agent engine seam is {@link GatewayAgentEngine} from
 * `../gateway/agent-handler` (team gateway-agent-bench's contract): the
 * honestly-`"[mock]"`-labelled {@link echoEngine} is the default, a real
 * `swarmEngine(manager)` is expected to be supplied later via
 * `overrides.engine` once a `GatewayManager` is wired at integration. Either
 * way `AgentGatewayHandler` never disguises which one is in effect — the
 * mock engine says so in every reply it produces (`engine.mode === "mock"`),
 * and a real engine's own output speaks for itself.
 *
 * @module hades/cli/gateway-deps
 */
import { join } from "node:path";
import type { HadesConfig } from "../config/config";
import { GatewayProcess } from "../gateway/process";
import type { PlatformProbe } from "../gateway/process";
import type { PlatformConnector } from "../gateway/connector";
import { FileIdentityStore, IdentityLinker, ContinuityRouter } from "../gateway/continuity";
import { FileTrustStore } from "../gateway/trust-store";
import { PairingGuard } from "../gateway/pairing";
import { BadgeStamper } from "../gateway/badge";
import { AgentGatewayHandler, echoEngine } from "../gateway/agent-handler";
import type { GatewayAgentEngine } from "../gateway/agent-handler";
import { resolveGatewayEngine, probeGatewayEngine } from "../gateway/engine-select";
import type { EngineProbe, ResolveGatewayEngineDeps } from "../gateway/engine-select";

export type { GatewayAgentEngine } from "../gateway/agent-handler";
export type { EngineProbe } from "../gateway/engine-select";

export interface GatewayCliDeps {
  process: GatewayProcess;
  pairing: PairingGuard;
  identityPath: string;
  trustPath: string;
  /** Honest report of which agent engine this invocation runs (or would run).
   *  Absent when the caller wired deps manually without engine resolution. */
  engineProbe?: EngineProbe;
  /** Tears down the resolved engine's swarm manager (if one was built).
   *  `start` calls this after the gateway stops; no-op for the mock engine. */
  engineShutdown?: () => Promise<void>;
}

/**
 * Build the full production `hades gateway` dependency graph from config +
 * env, composing (innermost first): {@link AgentGatewayHandler} (over
 * `overrides.engine` when supplied, else the mock `echoEngine`) →
 * {@link ContinuityRouter} → {@link BadgeStamper} → {@link PairingGuard} →
 * {@link GatewayProcess}.
 */
export function buildGatewayDeps(
  config: HadesConfig,
  env: Record<string, string | undefined>,
  overrides?: {
    connectors?: PlatformConnector[];
    report?: PlatformProbe[];
    engine?: GatewayAgentEngine;
    log?: (line: string) => void;
  }
): GatewayCliDeps {
  const identityPath = join(config.dataDir, "gateway", "identities.json");
  const trustPath = join(config.dataDir, "gateway", "trust.json");

  const identities = new FileIdentityStore(identityPath);
  const trust = new FileTrustStore(trustPath);
  // One shared TTL for both link codes (IdentityLinker) and pair codes
  // (PairingGuard): PairingGuard's "/link" reply reports its own codeTtlMs as
  // the link code's validity window, which is only accurate when the linker
  // is constructed with the same ttlMs — so both get this constant explicitly
  // rather than relying on their (currently equal) independent defaults.
  const codeTtlMs = 10 * 60 * 1000;
  const linker = new IdentityLinker(identities, { ttlMs: codeTtlMs });

  const engine = overrides?.engine ?? echoEngine();
  const agentHandler = new AgentGatewayHandler({ engine });
  const continuityRouter = new ContinuityRouter(identities, agentHandler.handle);
  const badgeStamper = new BadgeStamper();
  const badgedHandler = badgeStamper.wrap(continuityRouter.handle);

  const pairing = new PairingGuard({ trust, identities, linker, codeTtlMs });
  const finalHandler = pairing.wrap(badgedHandler);

  const process = new GatewayProcess({
    handler: finalHandler,
    env,
    connectors: overrides?.connectors,
    report: overrides?.report,
    log: overrides?.log,
  });

  return { process, pairing, identityPath, trustPath };
}

/**
 * The full env-honest composition the `hades` binary uses: resolve the agent
 * engine from environment (see ../gateway/engine-select) and build the
 * gateway deps around it.
 *
 * Engine construction is deliberately gated on `forStart`:
 *
 *  - `forStart: true` (`hades gateway start` without `--probe`): the engine
 *    is actually RESOLVED — behind `HADES_GATEWAY_ENGINE=swarm` plus a real
 *    provider key that means a real `LLMExecutor`-backed, STYX-certified
 *    swarm engine (and `engineShutdown` tears its manager down); every other
 *    env combination gets the honest `[mock]` echo engine. The probe reports
 *    exactly which one was built.
 *  - `forStart: false` (status/pair/send/--probe/help): nothing heavy is
 *    ever constructed just to print a line — the deps get the default echo
 *    engine (whose handler these subcommands never invoke) and a PURE
 *    `probeGatewayEngine` report of what `start` would build.
 */
export async function buildGatewayDepsFromEnv(
  config: HadesConfig,
  env: Record<string, string | undefined>,
  opts?: {
    forStart?: boolean;
    log?: (line: string) => void;
    /** Test seam forwarded to {@link resolveGatewayEngine}. */
    resolveDeps?: ResolveGatewayEngineDeps;
  }
): Promise<GatewayCliDeps> {
  if (opts?.forStart) {
    const resolved = await resolveGatewayEngine(env, opts?.resolveDeps);
    const deps = buildGatewayDeps(config, env, { engine: resolved.engine, log: opts?.log });
    return { ...deps, engineProbe: resolved.probe, engineShutdown: resolved.shutdown };
  }
  const deps = buildGatewayDeps(config, env, { log: opts?.log });
  return { ...deps, engineProbe: probeGatewayEngine(env) };
}
