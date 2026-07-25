/**
 * Hades desktop gateway wire protocol.
 *
 * Extension of the desktop IPC contract (`./contract.ts`) for the platform
 * gateway (`hades gateway`, `src/hades/gateway/process.ts`'s `GatewayProcess`,
 * `src/hades/gateway/pairing.ts`'s `PairingGuard`): `gateway.status.get`
 * answered by either a `gateway.status` snapshot or a `gateway.error`, and
 * `gateway.pair.issue` answered by either a `gateway.paircode` or a
 * `gateway.error`. The `GatewayCommand` union flows renderer -> sidecar,
 * `GatewayEvent` flows sidecar -> renderer, exactly like `Command`/`AppEvent`.
 *
 * This module mirrors `./contract.ts` / `./fleet-contract.ts` /
 * `./learning-contract.ts` conventions exactly (same guard shapes, same codec
 * error-message style) so it is ready to be merged into the
 * `Command`/`AppEvent` unions there. It is intentionally standalone: pure,
 * deterministic, dependency-free — it does not import from `./contract.ts`
 * or any of the other `*-contract.ts` modules (or anywhere else) so the
 * merge can happen without introducing a coupling in either direction.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/**
 * One platform's connectivity verdict, as the desktop UI understands it.
 * Mirrors `PlatformProbe` (`../../hades/gateway/process.ts`) exactly:
 * `detail` names env VARIABLE NAMES only — it is safe to render anywhere and
 * never carries a credential value.
 */
export interface GatewayProbeView {
  platform: string;
  mode: "real" | "offline";
  detail: string;
}

/** Live traffic counters, passed through unaltered from the engine. */
export interface GatewayCountersView {
  inbound: number;
  outbound: number;
  rateLimited: number;
}

/**
 * A full gateway status snapshot for the desktop shell.
 *
 * `startedAt` is `null` iff the gateway has never been started (the engine's
 * own `GatewayStatus.startedAt` is `undefined` in that case — this view never
 * forwards `undefined` over the wire, only `null`). `engine` is `null` when
 * no engine probe was configured for this sidecar (never a fabricated
 * "mock"/"real" verdict manufactured out of thin air).
 */
export interface GatewayStatusView {
  running: boolean;
  startedAt: number | null;
  platforms: GatewayProbeView[];
  counters: GatewayCountersView;
  engine: { requested: string; mode: "real" | "mock"; detail: string } | null;
  at: number;
}

/** A freshly issued pairing code, as the desktop UI understands it. */
export interface GatewayPairCodeView {
  code: string;
  level: "trusted" | "owner";
  expiresAt: number;
  at: number;
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type GatewayCommand =
  | { kind: "gateway.status.get" }
  | { kind: "gateway.pair.issue"; level: "trusted" | "owner" };

export type GatewayEvent =
  | { kind: "gateway.status"; status: GatewayStatusView }
  | { kind: "gateway.paircode"; pair: GatewayPairCodeView }
  | { kind: "gateway.error"; message: string; at: number };

export const GATEWAY_COMMAND_KINDS = [
  "gateway.status.get",
  "gateway.pair.issue",
] as const satisfies readonly GatewayCommand["kind"][];

export const GATEWAY_EVENT_KINDS = [
  "gateway.status",
  "gateway.paircode",
  "gateway.error",
] as const satisfies readonly GatewayEvent["kind"][];

// Compile-time exhaustiveness: fails to type-check if a kind is added to the
// `GatewayCommand`/`GatewayEvent` unions without adding it to the tuples
// above (or vice versa) — a mismatch in either direction breaks these
// assignments.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [
  Union,
] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;
const _commandKindsExact: ExactlyKindsOf<GatewayCommand["kind"], typeof GATEWAY_COMMAND_KINDS> = true;
const _eventKindsExact: ExactlyKindsOf<GatewayEvent["kind"], typeof GATEWAY_EVENT_KINDS> = true;
void _commandKindsExact;
void _eventKindsExact;

// ---------------------------------------------------------------------------
// Primitive type helpers
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNullableNumber(x: unknown): x is number | null {
  return x === null || isNumber(x);
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

function isOneOf<T extends string>(x: unknown, values: readonly T[]): x is T {
  return typeof x === "string" && (values as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// View model guards
// ---------------------------------------------------------------------------

const GATEWAY_MODES = ["real", "offline"] as const;
const TRUST_LEVELS = ["trusted", "owner"] as const;
const ENGINE_MODES = ["real", "mock"] as const;

export function isGatewayProbeView(x: unknown): x is GatewayProbeView {
  if (!isPlainObject(x)) return false;
  return isString(x.platform) && isOneOf(x.mode, GATEWAY_MODES) && isString(x.detail);
}

function isGatewayCountersView(x: unknown): x is GatewayCountersView {
  if (!isPlainObject(x)) return false;
  return isNumber(x.inbound) && isNumber(x.outbound) && isNumber(x.rateLimited);
}

function isGatewayEngineView(
  x: unknown
): x is { requested: string; mode: "real" | "mock"; detail: string } {
  if (!isPlainObject(x)) return false;
  return isString(x.requested) && isOneOf(x.mode, ENGINE_MODES) && isString(x.detail);
}

function isNullableGatewayEngineView(
  x: unknown
): x is { requested: string; mode: "real" | "mock"; detail: string } | null {
  return x === null || isGatewayEngineView(x);
}

export function isGatewayStatusView(x: unknown): x is GatewayStatusView {
  if (!isPlainObject(x)) return false;
  return (
    isBoolean(x.running) &&
    isNullableNumber(x.startedAt) &&
    Array.isArray(x.platforms) &&
    x.platforms.every(isGatewayProbeView) &&
    isGatewayCountersView(x.counters) &&
    isNullableGatewayEngineView(x.engine) &&
    isNumber(x.at)
  );
}

export function isGatewayPairCodeView(x: unknown): x is GatewayPairCodeView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.code) &&
    isOneOf(x.level, TRUST_LEVELS) &&
    isNumber(x.expiresAt) &&
    isNumber(x.at)
  );
}

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

export function isGatewayCommand(x: unknown): x is GatewayCommand {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "gateway.status.get":
      return true;
    case "gateway.pair.issue":
      return isOneOf(x.level, TRUST_LEVELS);
    default:
      return false;
  }
}

export function isGatewayEvent(x: unknown): x is GatewayEvent {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "gateway.status":
      return isGatewayStatusView(x.status);
    case "gateway.paircode":
      return isGatewayPairCodeView(x.pair);
    case "gateway.error":
      return isString(x.message) && isNumber(x.at);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

function parseLine(line: string, label: "command" | "event"): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error(`bad ${label}: empty line`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`bad ${label}: invalid JSON`);
  }
}

export function encodeGatewayEvent(e: GatewayEvent): string {
  return JSON.stringify(e) + "\n";
}

export function decodeGatewayCommand(raw: string): GatewayCommand {
  const parsed = parseLine(raw, "command");
  if (!isPlainObject(parsed) || typeof parsed.kind !== "string") {
    throw new Error("bad command: missing kind");
  }
  if (!(GATEWAY_COMMAND_KINDS as readonly string[]).includes(parsed.kind)) {
    throw new Error(`bad command: unknown kind "${parsed.kind}"`);
  }
  if (!isGatewayCommand(parsed)) {
    throw new Error(`bad command: missing or invalid fields for kind "${parsed.kind}"`);
  }
  return parsed;
}
